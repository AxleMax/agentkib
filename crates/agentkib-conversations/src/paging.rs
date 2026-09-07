//! Bounded, reverse JSONL history reads. Handoff/export deliberately retains its separate limit.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::io::{Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const SCAN_BYTES: usize = 16 * 1024 * 1024;
const SCAN_LINES: usize = 20_000;
const BLOCK_BYTES: usize = 64 * 1024;
const MAX_ASSOCIATIONS: usize = 20_000;
const ASSOCIATION_WINDOW: usize = 4096;
const MAX_STATES: usize = 32;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Format {
    Codex,
    Claude,
}

#[derive(Clone)]
struct Snapshot {
    path: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
    identity: (u64, u64),
    fingerprint: [u8; 32],
}

#[derive(Clone)]
struct ToolResult {
    status: Option<String>,
    duration: Option<u64>,
}

#[derive(Clone)]
struct Mirror {
    primary: bool,
    event_id: String,
    timestamp: Option<DateTime<Utc>>,
    turn: Option<String>,
    sequence: u64,
}

#[derive(Clone)]
struct State {
    snapshot: Snapshot,
    format: Format,
    position: u64,
    fragment: Vec<u8>,
    oversized: bool,
    trailing: bool,
    pending: VecDeque<ConversationEvent>,
    mirrors: BTreeMap<String, VecDeque<Mirror>>,
    tools: BTreeMap<String, ToolResult>,
    finished_tools: BTreeSet<String>,
    visible_turns: BTreeSet<String>,
    association_order: VecDeque<(u8, String)>,
    association_warning: bool,
    sequence: u64,
}

struct Stored {
    created: Instant,
    state: State,
}
static STATES: OnceLock<Mutex<BTreeMap<String, Stored>>> = OnceLock::new();

fn states() -> &'static Mutex<BTreeMap<String, Stored>> {
    STATES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn open_regular(path: &Path) -> Result<File> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| anyhow::anyhow!("TRANSCRIPT_UNREADABLE"))?;
    anyhow::ensure!(metadata.file_type().is_file(), "TRANSCRIPT_UNREADABLE");
    let file = File::open(path).map_err(|_| anyhow::anyhow!("TRANSCRIPT_UNREADABLE"))?;
    anyhow::ensure!(file.metadata()?.is_file(), "TRANSCRIPT_UNREADABLE");
    Ok(file)
}

pub(super) fn is_readable(path: &Path) -> bool {
    open_regular(path).is_ok()
}

#[cfg(unix)]
fn identity(metadata: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}
#[cfg(not(unix))]
fn identity(metadata: &fs::Metadata) -> (u64, u64) {
    metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or((0, 0), |time| {
            (time.as_secs(), u64::from(time.subsec_nanos()))
        })
}

fn fingerprint(file: &mut File, length: u64) -> Result<[u8; 32]> {
    let mut hash = Sha256::new();
    let mut bytes = vec![0; length.min(4096) as usize];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut bytes)?;
    hash.update(&bytes);
    file.seek(SeekFrom::Start(length.saturating_sub(bytes.len() as u64)))?;
    file.read_exact(&mut bytes)?;
    hash.update(&bytes);
    Ok(hash.finalize().into())
}

impl State {
    fn estimated_bytes(&self) -> usize {
        let events = self.pending.iter();
        self.fragment.capacity()
            + events
                .map(|event| {
                    std::mem::size_of::<ConversationEvent>()
                        + event.content.as_ref().map_or(0, String::capacity)
                        + event.id.capacity()
                        + event.tool_name.as_ref().map_or(0, String::capacity)
                        + event.tool_status.as_ref().map_or(0, String::capacity)
                })
                .sum::<usize>()
            + self
                .mirrors
                .values()
                .map(|queue| 256 + queue.len() * 384)
                .sum::<usize>()
            + (self.tools.len() + self.finished_tools.len() + self.visible_turns.len()) * 256
            + self.association_order.len() * 128
    }
    fn new(path: &Path, file: &mut File, format: Format) -> Result<Self> {
        let metadata = file.metadata()?;
        Ok(Self {
            snapshot: Snapshot {
                path: path.to_path_buf(),
                length: metadata.len(),
                modified: metadata.modified().ok(),
                identity: identity(&metadata),
                fingerprint: fingerprint(file, metadata.len())?,
            },
            format,
            position: metadata.len(),
            fragment: Vec::new(),
            oversized: false,
            trailing: true,
            pending: VecDeque::new(),
            mirrors: BTreeMap::new(),
            tools: BTreeMap::new(),
            finished_tools: BTreeSet::new(),
            visible_turns: BTreeSet::new(),
            association_order: VecDeque::new(),
            association_warning: false,
            sequence: 0,
        })
    }

    fn remember(&mut self, kind: u8, key: String) {
        self.association_order.push_back((kind, key));
        while self.association_order.len() > ASSOCIATION_WINDOW {
            if let Some((kind, key)) = self.association_order.pop_front() {
                let removed = match kind {
                    0 => self.mirrors.remove(&key).is_some(),
                    1 => self.tools.remove(&key).is_some(),
                    2 => self.finished_tools.remove(&key),
                    _ => self.visible_turns.remove(&key),
                };
                self.association_warning |= removed;
            }
        }
    }

    fn validate(&self, path: &Path, file: &mut File, format: Format) -> Result<()> {
        let metadata = file.metadata()?;
        anyhow::ensure!(
            self.snapshot.path == path && self.format == format,
            "TRANSCRIPT_CURSOR_INVALID"
        );
        anyhow::ensure!(
            metadata.len() >= self.snapshot.length && identity(&metadata) == self.snapshot.identity,
            "TRANSCRIPT_CURSOR_STALE"
        );
        anyhow::ensure!(
            metadata.len() != self.snapshot.length
                || metadata.modified().ok() == self.snapshot.modified,
            "TRANSCRIPT_CURSOR_STALE"
        );
        anyhow::ensure!(
            fingerprint(file, self.snapshot.length)? == self.snapshot.fingerprint,
            "TRANSCRIPT_CURSOR_STALE"
        );
        Ok(())
    }

    fn check_budget(&self) -> Result<()> {
        let associations = self.mirrors.values().map(VecDeque::len).sum::<usize>()
            + self.tools.len()
            + self.finished_tools.len()
            + self.visible_turns.len()
            + self.pending.len();
        anyhow::ensure!(
            associations <= MAX_ASSOCIATIONS,
            "TRANSCRIPT_SCAN_STATE_LIMIT"
        );
        // Context is exceptional and can contain large text; never retain unbounded bodies.
        let context_bytes: usize = self
            .pending
            .iter()
            .map(|event| event.content.as_ref().map_or(0, String::len))
            .sum();
        anyhow::ensure!(
            context_bytes <= 8 * MAX_PAGE_BYTES,
            "TRANSCRIPT_SCAN_STATE_LIMIT"
        );
        Ok(())
    }
}

struct ReverseReader<'a> {
    file: &'a mut File,
    buffer: Vec<u8>,
    index: usize,
    bytes: usize,
}
enum Record {
    Line(u64, Vec<u8>),
    Oversized,
    Budget,
    End,
}

impl<'a> ReverseReader<'a> {
    fn new(file: &'a mut File) -> Self {
        Self {
            file,
            buffer: vec![],
            index: 0,
            bytes: 0,
        }
    }
    fn next(&mut self, state: &mut State) -> Result<Record> {
        loop {
            if state.position == 0 {
                if state.fragment.is_empty() && !state.oversized {
                    return Ok(Record::End);
                }
                return Ok(finish_line(state, 0));
            }
            if self.index == 0 {
                if self.bytes >= SCAN_BYTES {
                    return Ok(Record::Budget);
                }
                let count = state
                    .position
                    .min(BLOCK_BYTES.min(SCAN_BYTES - self.bytes) as u64)
                    as usize;
                self.buffer.resize(count, 0);
                self.file
                    .seek(SeekFrom::Start(state.position - count as u64))?;
                self.file
                    .read_exact(&mut self.buffer)
                    .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_STALE"))?;
                self.index = count;
                self.bytes += count;
            }
            self.index -= 1;
            state.position -= 1;
            let byte = self.buffer[self.index];
            if byte == b'\n' {
                return Ok(finish_line(state, state.position + 1));
            }
            if !state.oversized {
                if state.fragment.len() == MAX_LINE_BYTES {
                    state.fragment.clear();
                    state.oversized = true;
                } else {
                    state.fragment.push(byte);
                }
            }
        }
    }
}

fn finish_line(state: &mut State, offset: u64) -> Record {
    if state.oversized {
        state.oversized = false;
        return Record::Oversized;
    }
    let mut bytes = std::mem::take(&mut state.fragment);
    bytes.reverse();
    Record::Line(offset, bytes)
}

pub(super) fn read_page(
    path: &Path,
    cursor: Option<&str>,
    limit: usize,
    format: Format,
) -> Result<ConversationEventPage> {
    let mut file = open_regular(path)?;
    let mut state = if let Some(cursor) = cursor {
        anyhow::ensure!(
            cursor.starts_with("history-v1-") && cursor.len() <= 64,
            "TRANSCRIPT_CURSOR_INVALID"
        );
        let cache = states()
            .lock()
            .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_STALE"))?;
        let stored = cache
            .get(cursor)
            .filter(|stored| stored.created.elapsed() < TTL)
            .ok_or_else(|| anyhow::anyhow!("TRANSCRIPT_CURSOR_STALE"))?;
        stored.state.clone()
    } else {
        State::new(path, &mut file, format)?
    };
    state.validate(path, &mut file, format)?;
    let mut events = Vec::<ConversationEvent>::new();
    let mut warnings = BTreeSet::new();
    let mut reader = ReverseReader::new(&mut file);
    let mut lines = 0;
    let mut event_bytes = 0;
    loop {
        if let Some(event) = state.pending.front() {
            let bytes = event.content.as_ref().map_or(0, String::len);
            if events.len() >= limit.clamp(1, 100) || event_bytes + bytes > MAX_PAGE_BYTES {
                break;
            }
            event_bytes += bytes;
            events.push(state.pending.pop_front().expect("front was present"));
            continue;
        }
        if lines >= SCAN_LINES {
            warnings.insert("TRANSCRIPT_SCAN_BUDGET".to_string());
            break;
        }
        match reader.next(&mut state)? {
            Record::Budget => {
                warnings.insert("TRANSCRIPT_SCAN_BUDGET".to_string());
                break;
            }
            Record::End => break,
            Record::Oversized => {
                state.trailing = false;
                warnings.insert("TRANSCRIPT_OVERSIZED_LINES".to_string());
            }
            Record::Line(offset, bytes) => {
                if state.trailing {
                    state.trailing = false;
                    continue;
                }
                lines += 1;
                state.sequence += 1;
                if bytes.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) => parse_record(&mut state, offset, &value, &mut events),
                    Err(_) => {
                        warnings.insert("TRANSCRIPT_DAMAGED_LINES".to_string());
                    }
                }
                state.check_budget()?;
            }
        }
    }
    state.validate(path, reader.file, format)?;
    if state.association_warning {
        warnings.insert("TRANSCRIPT_ASSOCIATION_WINDOW".to_string());
    }
    let next_cursor =
        if state.position > 0 || !state.pending.is_empty() || !state.fragment.is_empty() {
            let id = format!("history-v1-{}", uuid::Uuid::new_v4());
            let mut cache = states()
                .lock()
                .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_STALE"))?;
            cache.retain(|_, stored| stored.created.elapsed() < TTL);
            let size = state.estimated_bytes();
            anyhow::ensure!(size <= MAX_CACHE_BYTES, "TRANSCRIPT_SCAN_STATE_LIMIT");
            while cache.len() >= MAX_STATES
                || cache
                    .values()
                    .map(|stored| stored.state.estimated_bytes())
                    .sum::<usize>()
                    + size
                    > MAX_CACHE_BYTES
            {
                let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, stored)| stored.created)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                cache.remove(&oldest);
            }
            cache.insert(
                id.clone(),
                Stored {
                    created: Instant::now(),
                    state,
                },
            );
            Some(id)
        } else {
            None
        };
    events.reverse();
    Ok(ConversationEventPage {
        events,
        next_cursor,
        warnings: warnings.into_iter().collect(),
    })
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn message(
    state: &mut State,
    offset: u64,
    kind: ConversationEventKind,
    timestamp: Option<DateTime<Utc>>,
    content: &str,
    attachments: u64,
    primary: bool,
    turn: Option<&str>,
    page: &mut [ConversationEvent],
) {
    let event = message_event(offset as usize, kind, timestamp, content, attachments).event;
    if state.format == Format::Codex {
        // Record timestamps are write times, not message IDs. Prefer explicit turn identity;
        // older logs use nearby opposite-format occurrences with a small timestamp tolerance.
        let key = hash(&message_key(kind, content));
        let turn = turn.map(hash);
        let mirrors = state.mirrors.entry(key.clone()).or_default();
        let candidates = mirrors
            .iter()
            .enumerate()
            .filter(|(_, mirror)| {
                mirror.primary != primary
                    && state.sequence.saturating_sub(mirror.sequence) <= 64
                    && match (&turn, &mirror.turn) {
                        (Some(turn), Some(other)) => turn == other,
                        _ => match (timestamp, mirror.timestamp) {
                            (Some(left), Some(right)) => {
                                left.timestamp_millis().abs_diff(right.timestamp_millis()) <= 1000
                            }
                            _ => true,
                        },
                    }
            })
            .collect::<Vec<_>>();
        if candidates.len() > 1 {
            state.association_warning = true;
        }
        let matching = candidates
            .iter()
            .min_by_key(|(_, mirror)| {
                (
                    match (&turn, &mirror.turn) {
                        (Some(left), Some(right)) if left == right => 0,
                        _ => 1,
                    },
                    match (timestamp, mirror.timestamp) {
                        (Some(left), Some(right)) => {
                            left.timestamp_millis().abs_diff(right.timestamp_millis())
                        }
                        _ => u64::MAX,
                    },
                    state.sequence.saturating_sub(mirror.sequence),
                )
            })
            .map(|(index, _)| *index);
        if let Some(index) = matching {
            let counterpart = mirrors.remove(index).expect("mirror exists");
            if primary
                && let Some(existing) = page
                    .iter_mut()
                    .chain(state.pending.iter_mut())
                    .find(|event| event.id == counterpart.event_id)
            {
                existing.attachment_count = attachments;
            } else if primary && attachments > 0 {
                // The mirrored event may already have been delivered by an earlier page.
                // Keep its stable identity rather than replaying a second message.
                state.association_warning = true;
            }
            if mirrors.is_empty() {
                state.mirrors.remove(&key);
            }
            return;
        }
        mirrors.push_back(Mirror {
            primary,
            event_id: event.id.clone(),
            timestamp,
            turn,
            sequence: state.sequence,
        });
        state.remember(0, key);
    }
    state.pending.push_back(event);
}

fn tool(
    state: &mut State,
    offset: u64,
    index: usize,
    id: &str,
    name: &str,
    timestamp: Option<DateTime<Utc>>,
    default_status: Option<&str>,
) {
    let key = hash(id);
    if !id.is_empty() && !state.finished_tools.insert(key.clone()) {
        return;
    }
    state.remember(2, key.clone());
    let result = state.tools.remove(&key);
    state.pending.push_back(ConversationEvent {
        id: format!("tool-{offset}-{index}"),
        kind: ConversationEventKind::ToolSummary,
        timestamp,
        content: None,
        tool_name: Some(sanitize_tool_name(name)),
        tool_status: result
            .as_ref()
            .and_then(|value| value.status.clone())
            .or_else(|| default_status.map(sanitize_tool_status)),
        duration_ms: result.and_then(|value| value.duration),
        attachment_count: 0,
        truncated: false,
    });
}

fn result(state: &mut State, id: &str, status: Option<&str>, duration: Option<u64>) {
    if id.is_empty() {
        return;
    }
    let entry = state.tools.entry(hash(id)).or_insert(ToolResult {
        status: None,
        duration: None,
    });
    // Reverse reading: the first result encountered is the latest state.
    if entry.status.is_none() {
        entry.status = status.map(sanitize_tool_status);
    }
    if entry.duration.is_none() {
        entry.duration = duration;
    }
    state.remember(1, hash(id));
}

fn parse_record(state: &mut State, offset: u64, value: &Value, page: &mut [ConversationEvent]) {
    let timestamp = value.get("timestamp").and_then(parse_json_timestamp);
    if state.format == Format::Claude {
        let record_type = value.get("type").and_then(Value::as_str);
        if !matches!(record_type, Some("user" | "assistant"))
            || value.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let Some(content) = value.pointer("/message/content") else {
            return;
        };
        if let Some(blocks) = content.as_array() {
            for (index, block) in blocks.iter().enumerate().rev() {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_result") => result(
                        state,
                        block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        Some(
                            if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                                "failed"
                            } else {
                                "completed"
                            },
                        ),
                        None,
                    ),
                    Some("tool_use") => tool(
                        state,
                        offset,
                        index,
                        block.get("id").and_then(Value::as_str).unwrap_or(""),
                        block.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        timestamp,
                        Some("started"),
                    ),
                    _ => {}
                }
            }
        }
        if let Some(text) = response_message_text(Some(content))
            && !text.trim().is_empty()
            && !is_claude_command_echo(&text)
        {
            let role = value
                .pointer("/message/role")
                .and_then(Value::as_str)
                .or(record_type);
            message(
                state,
                offset,
                if role == Some("assistant") {
                    ConversationEventKind::AgentMessage
                } else {
                    ConversationEventKind::UserMessage
                },
                timestamp,
                &text,
                claude_attachment_count(content),
                true,
                None,
                page,
            );
        }
        return;
    }
    let payload = value.get("payload").unwrap_or(&Value::Null);
    let id = payload.get("call_id").and_then(Value::as_str).unwrap_or("");
    let turn = payload
        .get("turn_id")
        .or_else(|| payload.pointer("/internal_chat_message_metadata_passthrough/turn_id"))
        .and_then(Value::as_str);
    match (
        value.get("type").and_then(Value::as_str),
        payload.get("type").and_then(Value::as_str),
    ) {
        (Some("event_msg"), Some(kind @ ("user_message" | "agent_message"))) => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                message(
                    state,
                    offset,
                    if kind == "user_message" {
                        ConversationEventKind::UserMessage
                    } else {
                        ConversationEventKind::AgentMessage
                    },
                    timestamp,
                    text,
                    attachment_count(value),
                    true,
                    turn,
                    page,
                );
            }
        }
        (Some("response_item"), Some("message")) => {
            let role = payload.get("role").and_then(Value::as_str);
            if !matches!(role, Some("user" | "assistant")) {
                return;
            }
            let Some(content) = payload.get("content") else {
                return;
            };
            let Some(text) = response_message_text(Some(content)) else {
                return;
            };
            if role == Some("user")
                && let Some(turn) = payload
                    .pointer("/internal_chat_message_metadata_passthrough/turn_id")
                    .and_then(Value::as_str)
            {
                let turn = hash(turn);
                if is_injected_codex_context_content(content) {
                    if state.visible_turns.contains(&turn) {
                        return;
                    }
                    // A user may intentionally send context-looking text. Without a visible
                    // same-turn message in the inspected suffix, preserve it rather than hide it.
                    state.association_warning = true;
                } else {
                    state.visible_turns.insert(turn.clone());
                    state.remember(3, turn);
                }
            }
            message(
                state,
                offset,
                if role == Some("user") {
                    ConversationEventKind::UserMessage
                } else {
                    ConversationEventKind::AgentMessage
                },
                timestamp,
                &text,
                content.as_array().map_or(0, |blocks| {
                    blocks
                        .iter()
                        .filter(|block| {
                            matches!(
                                block.get("type").and_then(Value::as_str),
                                Some("input_image" | "image" | "document")
                            )
                        })
                        .count() as u64
                }),
                false,
                turn,
                page,
            );
        }
        (Some("response_item"), Some("function_call" | "custom_tool_call")) => tool(
            state,
            offset,
            0,
            id,
            payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool"),
            timestamp,
            payload.get("status").and_then(Value::as_str),
        ),
        (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
            result(state, id, Some("completed"), None)
        }
        (Some("event_msg"), Some(kind @ ("exec_command_end" | "patch_apply_end"))) => {
            let status = payload.get("status").and_then(Value::as_str).or_else(|| {
                payload
                    .get("success")
                    .and_then(Value::as_bool)
                    .map(|success| if success { "completed" } else { "failed" })
            });
            let duration = payload
                .get("duration")
                .and_then(Value::as_f64)
                .map(|duration| (duration * 1000.0).max(0.0) as u64);
            result(state, id, status, duration);
            tool(
                state,
                offset,
                0,
                id,
                if kind == "exec_command_end" {
                    "shell"
                } else {
                    "apply_patch"
                },
                timestamp,
                status,
            );
        }
        (Some("response_item"), Some("web_search_call")) => tool(
            state,
            offset,
            0,
            "",
            "web_search",
            timestamp,
            payload.get("status").and_then(Value::as_str),
        ),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn primary(text: &str) -> Value {
        serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":text}})
    }
    fn write_records(path: &Path, records: &[Value]) {
        let mut file = File::create(path).unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }
    fn all(path: &Path, format: Format, limit: usize) -> Vec<ConversationEvent> {
        let mut cursor = None;
        let mut events = Vec::new();
        for _ in 0..1000 {
            let page = read_page(path, cursor.as_deref(), limit, format).unwrap();
            let mut older = page.events;
            older.extend(events);
            events = older;
            cursor = page.next_cursor;
            if cursor.is_none() {
                return events;
            }
        }
        panic!("paging failed to make progress");
    }

    #[test]
    fn latest_fifty_and_older_pages_preserve_order_and_stable_retry() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        write_records(
            &path,
            &(0..137)
                .map(|index| primary(&index.to_string()))
                .collect::<Vec<_>>(),
        );
        let latest = read_page(&path, None, DEFAULT_HISTORY_PAGE_SIZE, Format::Codex).unwrap();
        assert_eq!(latest.events.len(), 50);
        assert_eq!(latest.events[0].content.as_deref(), Some("87"));
        let second = read_page(&path, latest.next_cursor.as_deref(), 50, Format::Codex).unwrap();
        let retry = read_page(&path, latest.next_cursor.as_deref(), 50, Format::Codex).unwrap();
        assert_eq!(
            serde_json::to_value(second.events).unwrap(),
            serde_json::to_value(retry.events).unwrap()
        );
        assert_eq!(all(&path, Format::Codex, 50).len(), 137);
    }

    #[test]
    fn sparse_transcript_over_256_mib_reads_tail_but_handoff_stays_limited() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large.jsonl");
        let mut file = File::create(&path).unwrap();
        file.set_len(MAX_TRANSCRIPT_BYTES + 4096).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        writeln!(file).unwrap();
        for index in 0..60 {
            writeln!(file, "{}", primary(&index.to_string())).unwrap();
        }
        let page = read_page(&path, None, 50, Format::Codex).unwrap();
        assert_eq!(page.events.len(), 50);
        assert_eq!(page.events[0].content.as_deref(), Some("10"));
        assert!(
            read_codex_handoff_context(&path)
                .unwrap_err()
                .to_string()
                .contains("256 MiB")
        );
    }

    #[test]
    fn large_claude_without_index_is_discovered_from_bounded_header() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let project = dir.path().join("projects/project");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("large-session.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"user","sessionId":"large-session","cwd":workspace,"message":{"role":"user","content":"initial"}})).unwrap();
        file.set_len(MAX_TRANSCRIPT_BYTES + 4096).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        writeln!(file).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"assistant","message":{"role":"assistant","content":"latest"}})).unwrap();
        let provider = ClaudeProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].availability, SessionAvailability::Readable);
        let page = provider.read_events("large-session", None, 1).unwrap();
        assert_eq!(page.events[0].content.as_deref(), Some("latest"));
    }

    #[test]
    fn append_is_frozen_but_truncate_replacement_and_wrong_cursor_are_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        write_records(
            &path,
            &(0..10)
                .map(|index| primary(&index.to_string()))
                .collect::<Vec<_>>(),
        );
        let page = read_page(&path, None, 2, Format::Codex).unwrap();
        let cursor = page.next_cursor.unwrap();
        let before = read_page(&path, Some(&cursor), 2, Format::Codex).unwrap();
        writeln!(
            fs::OpenOptions::new().append(true).open(&path).unwrap(),
            "{}",
            primary("new")
        )
        .unwrap();
        let after = read_page(&path, Some(&cursor), 2, Format::Codex).unwrap();
        assert_eq!(
            serde_json::to_value(before.events).unwrap(),
            serde_json::to_value(after.events).unwrap()
        );
        assert!(
            read_page(&path, Some("p1"), 2, Format::Codex)
                .unwrap_err()
                .to_string()
                .contains("INVALID")
        );
        let other = dir.path().join("other.jsonl");
        write_records(&other, &[primary("other")]);
        assert!(
            read_page(&other, Some(&cursor), 2, Format::Codex)
                .unwrap_err()
                .to_string()
                .contains("INVALID")
        );
        write_records(&path, &[primary("replacement")]);
        assert!(
            read_page(&path, Some(&cursor), 2, Format::Codex)
                .unwrap_err()
                .to_string()
                .contains("STALE")
        );
    }

    #[test]
    fn oversized_line_crosses_budget_without_becoming_a_record_fragment() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large-line.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", primary("old")).unwrap();
        for _ in 0..18 {
            file.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
        }
        writeln!(file).unwrap();
        writeln!(file, "{{bad").unwrap();
        writeln!(file, "{}", primary("new")).unwrap();
        let page = read_page(&path, None, 50, Format::Codex).unwrap();
        assert_eq!(page.events.len(), 1);
        assert!(
            page.warnings
                .iter()
                .any(|warning| warning == "TRANSCRIPT_SCAN_BUDGET")
        );
        let older = read_page(&path, page.next_cursor.as_deref(), 50, Format::Codex).unwrap();
        assert_eq!(older.events[0].content.as_deref(), Some("old"));
        assert!(
            older
                .warnings
                .iter()
                .any(|warning| warning == "TRANSCRIPT_OVERSIZED_LINES")
        );
    }

    #[test]
    fn claude_multiblock_page_one_keeps_unique_ids_and_completed_tools() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("claude.jsonl");
        write_records(
            &path,
            &[
                serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"answer"},{"type":"tool_use","id":"a","name":"Read"},{"type":"tool_use","id":"b","name":"Write"}]}}),
                serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"secret payload"},{"type":"tool_result","tool_use_id":"b","is_error":true}]}}),
            ],
        );
        let events = all(&path, Format::Claude, 1);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .iter()
                .map(|event| &event.id)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        assert_eq!(events[1].tool_status.as_deref(), Some("completed"));
        assert_eq!(events[2].tool_status.as_deref(), Some("failed"));
        assert!(!format!("{events:?}").contains("secret payload"));
    }

    #[test]
    fn mirrors_do_not_suppress_same_format_repetitions_or_different_timestamps() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("codex.jsonl");
        let fallback = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}});
        write_records(
            &path,
            &[
                primary("again"),
                fallback.clone(),
                primary("again"),
                fallback,
            ],
        );
        assert_eq!(all(&path, Format::Codex, 1).len(), 2);
        write_records(
            &path,
            &[primary("again"), primary("again"), primary("again")],
        );
        assert_eq!(all(&path, Format::Codex, 1).len(), 3);
    }

    #[test]
    fn mirrored_write_times_can_differ_or_be_missing_and_turns_remain_distinct() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mirror-times.jsonl");
        let mut primary = primary("again");
        primary["timestamp"] = serde_json::json!("2026-09-07T00:00:00.001Z");
        let mut fallback = serde_json::json!({"timestamp":"2026-09-07T00:00:00.002Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"again"}]}});
        for pair in [
            vec![primary.clone(), fallback.clone()],
            vec![fallback.clone(), primary.clone()],
        ] {
            write_records(&path, &pair);
            assert_eq!(all(&path, Format::Codex, 1).len(), 1);
        }
        fallback.as_object_mut().unwrap().remove("timestamp");
        write_records(&path, &[primary.clone(), fallback.clone()]);
        assert_eq!(all(&path, Format::Codex, 1).len(), 1);
        primary["payload"]["turn_id"] = serde_json::json!("first");
        fallback["payload"]["internal_chat_message_metadata_passthrough"] =
            serde_json::json!({"turn_id":"second"});
        write_records(&path, &[primary, fallback]);
        assert_eq!(all(&path, Format::Codex, 1).len(), 2);
    }

    #[test]
    fn tool_completion_across_sparse_scan_page_is_carried_to_older_call() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tool-pages.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{}", serde_json::json!({"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"Read","arguments":"secret"}})).unwrap();
        for _ in 0..SCAN_LINES + 1 {
            writeln!(file, "{{}}").unwrap();
        }
        writeln!(file, "{}", serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"secret"}})).unwrap();
        let page = read_page(&path, None, 50, Format::Codex).unwrap();
        assert!(page.events.is_empty());
        assert!(page.next_cursor.is_some());
        let older = read_page(&path, page.next_cursor.as_deref(), 50, Format::Codex).unwrap();
        assert_eq!(older.events.len(), 1);
        assert_eq!(older.events[0].tool_status.as_deref(), Some("completed"));
        assert!(!format!("{older:?}").contains("secret"));
    }

    #[test]
    fn unmatched_completion_and_context_like_text_do_not_block_tail() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("codex.jsonl");
        let mut records = (0..21_000)
            .map(|index| primary(&index.to_string()))
            .collect::<Vec<_>>();
        records.push(serde_json::json!({"type":"event_msg","payload":{"type":"exec_command_end","call_id":"standalone","status":"completed"}}));
        records.push(serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"turn_id":"literal"},"content":[{"type":"input_text","text":"<path>literal</path>"}]}}));
        write_records(&path, &records);
        let page = read_page(&path, None, 50, Format::Codex).unwrap();
        assert_eq!(page.events.len(), 50);
        assert_eq!(
            page.events.last().unwrap().content.as_deref(),
            Some("<path>literal</path>")
        );
        assert_eq!(all(&path, Format::Codex, 100).len(), 21_002);
    }
}
