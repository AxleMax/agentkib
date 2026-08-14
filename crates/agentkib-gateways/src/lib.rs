use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agentkib_platform::fs::{ExpectedFile, atomic_write_checked};
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use rand_core::OsRng;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use uuid::Uuid;

const DOCUMENT_VERSION: u32 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const OPENCLAW_CLIENT_ID: &str = "cli";
const OPENCLAW_CLIENT_MODE: &str = "cli";
static REGISTRY_WRITE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteGatewayKind {
    OpenClaw,
    Hermes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteGatewayAuthKind {
    None,
    Token,
    Password,
    SessionToken,
    Basic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteGatewayState {
    Pending,
    Connected,
    PairingRequired,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGatewayInput {
    pub id: Option<String>,
    pub kind: RemoteGatewayKind,
    pub name: String,
    pub url: String,
    pub auth_kind: RemoteGatewayAuthKind,
    pub username: Option<String>,
    /// Empty on update means that the existing credential remains unchanged.
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGatewayWorkspace {
    pub id: String,
    pub agent_id: Option<String>,
    pub name: String,
    pub path: Option<String>,
    pub session_count: u64,
    pub last_active_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGatewayAsset {
    pub id: String,
    pub agent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGatewaySummary {
    pub id: String,
    pub kind: RemoteGatewayKind,
    pub name: String,
    pub url: String,
    pub auth_kind: RemoteGatewayAuthKind,
    pub username: Option<String>,
    pub has_credentials: bool,
    pub state: RemoteGatewayState,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub session_count: u64,
    pub workspaces: Vec<RemoteGatewayWorkspace>,
    pub assets: Vec<RemoteGatewayAsset>,
    pub pairing_request_id: Option<String>,
    pub last_connected_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredGateway {
    id: String,
    kind: RemoteGatewayKind,
    name: String,
    url: String,
    auth_kind: RemoteGatewayAuthKind,
    username: Option<String>,
    secret: Option<String>,
    #[serde(default)]
    device_identity: Option<DeviceIdentity>,
    #[serde(default)]
    device_token: Option<String>,
    state: RemoteGatewayState,
    version: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    session_count: u64,
    #[serde(default)]
    workspaces: Vec<RemoteGatewayWorkspace>,
    #[serde(default)]
    assets: Vec<RemoteGatewayAsset>,
    pairing_request_id: Option<String>,
    last_connected_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DeviceIdentity {
    device_id: String,
    public_key: String,
    private_key: String,
}

#[derive(Default, Serialize, Deserialize)]
struct GatewayDocument {
    #[serde(default = "document_version")]
    version: u32,
    #[serde(default)]
    gateways: Vec<StoredGateway>,
    #[serde(skip)]
    original_hash: Option<String>,
}

fn document_version() -> u32 {
    DOCUMENT_VERSION
}

pub fn default_registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("remote-gateways.local.json")
}

pub fn list(path: &Path) -> Result<Vec<RemoteGatewaySummary>> {
    Ok(load_document(path)?
        .gateways
        .iter()
        .map(StoredGateway::summary)
        .collect())
}

pub async fn save(path: &Path, input: RemoteGatewayInput) -> Result<RemoteGatewaySummary> {
    let _guard = REGISTRY_WRITE_LOCK.lock().await;
    validate_input(&input)?;
    let mut document = load_document(path)?;
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Some(existing) = document.gateways.iter_mut().find(|item| item.id == id) {
        let normalized_url = normalize_url(input.kind, &input.url)?;
        let kind_changed = existing.kind != input.kind;
        let auth_changed = existing.kind != input.kind || existing.auth_kind != input.auth_kind;
        let endpoint_changed = existing.url != normalized_url;
        let supplied_secret = trimmed(input.secret);
        let secret_changed = supplied_secret.is_some();
        existing.kind = input.kind;
        existing.name = input.name.trim().to_owned();
        existing.url = normalized_url;
        existing.auth_kind = input.auth_kind;
        existing.username = trimmed(input.username);
        if input.auth_kind == RemoteGatewayAuthKind::None {
            existing.secret = None;
        } else if auth_changed || supplied_secret.is_some() {
            existing.secret = supplied_secret;
        }
        if auth_changed || endpoint_changed || secret_changed || existing.secret.is_none() {
            existing.device_token = None;
        }
        if kind_changed || endpoint_changed {
            existing.version = None;
            existing.capabilities.clear();
            existing.session_count = 0;
            existing.workspaces.clear();
            existing.assets.clear();
            existing.pairing_request_id = None;
            existing.last_connected_at = None;
        }
        existing.state = RemoteGatewayState::Pending;
        existing.last_error = None;
    } else {
        document.gateways.push(StoredGateway {
            id: id.clone(),
            kind: input.kind,
            name: input.name.trim().to_owned(),
            url: normalize_url(input.kind, &input.url)?,
            auth_kind: input.auth_kind,
            username: trimmed(input.username),
            secret: trimmed(input.secret),
            device_identity: None,
            device_token: None,
            state: RemoteGatewayState::Pending,
            version: None,
            capabilities: Vec::new(),
            session_count: 0,
            workspaces: Vec::new(),
            assets: Vec::new(),
            pairing_request_id: None,
            last_connected_at: None,
            last_error: None,
        });
    }
    save_document(path, &document)?;
    refresh_unlocked(path, &id).await
}

pub async fn refresh(path: &Path, id: &str) -> Result<RemoteGatewaySummary> {
    let _guard = REGISTRY_WRITE_LOCK.lock().await;
    refresh_unlocked(path, id).await
}

async fn refresh_unlocked(path: &Path, id: &str) -> Result<RemoteGatewaySummary> {
    let mut document = load_document(path)?;
    let gateway = document
        .gateways
        .iter_mut()
        .find(|item| item.id == id)
        .context("Remote gateway does not exist")?;
    refresh_stored_gateway(gateway).await;
    let summary = gateway.summary();
    save_document(path, &document)?;
    Ok(summary)
}

pub async fn refresh_all(path: &Path) -> Result<Vec<RemoteGatewaySummary>> {
    let _guard = REGISTRY_WRITE_LOCK.lock().await;
    let mut document = load_document(path)?;
    for gateway in &mut document.gateways {
        refresh_stored_gateway(gateway).await;
    }
    let output = document
        .gateways
        .iter()
        .map(StoredGateway::summary)
        .collect();
    save_document(path, &document)?;
    Ok(output)
}

async fn refresh_stored_gateway(gateway: &mut StoredGateway) {
    let result = match gateway.kind {
        RemoteGatewayKind::OpenClaw => refresh_openclaw(gateway).await,
        RemoteGatewayKind::Hermes => refresh_hermes(gateway).await,
    };
    if let Err(error) = result {
        gateway.state = RemoteGatewayState::Error;
        gateway.last_error = Some(error.to_string());
    }
}

pub async fn remove(path: &Path, id: &str) -> Result<()> {
    let _guard = REGISTRY_WRITE_LOCK.lock().await;
    let mut document = load_document(path)?;
    document.gateways.retain(|gateway| gateway.id != id);
    save_document(path, &document)
}

impl StoredGateway {
    fn summary(&self) -> RemoteGatewaySummary {
        RemoteGatewaySummary {
            id: self.id.clone(),
            kind: self.kind,
            name: self.name.clone(),
            url: self.url.clone(),
            auth_kind: self.auth_kind,
            username: self.username.clone(),
            has_credentials: self
                .secret
                .as_deref()
                .is_some_and(|value| !value.is_empty())
                || self.device_token.is_some(),
            state: self.state,
            version: self.version.clone(),
            capabilities: self.capabilities.clone(),
            session_count: self.session_count,
            workspaces: self.workspaces.clone(),
            assets: self.assets.clone(),
            pairing_request_id: self.pairing_request_id.clone(),
            last_connected_at: self.last_connected_at,
            last_error: self.last_error.clone(),
        }
    }
}

fn validate_input(input: &RemoteGatewayInput) -> Result<()> {
    if input.name.trim().is_empty() {
        bail!("Remote gateway name cannot be empty");
    }
    if input.url.trim().is_empty() {
        bail!("Remote gateway URL cannot be empty");
    }
    match (input.kind, input.auth_kind) {
        (
            RemoteGatewayKind::OpenClaw,
            RemoteGatewayAuthKind::None
            | RemoteGatewayAuthKind::Token
            | RemoteGatewayAuthKind::Password,
        )
        | (
            RemoteGatewayKind::Hermes,
            RemoteGatewayAuthKind::None
            | RemoteGatewayAuthKind::SessionToken
            | RemoteGatewayAuthKind::Basic,
        ) => {}
        _ => bail!("Authentication mode is not supported by this gateway"),
    }
    if input.auth_kind == RemoteGatewayAuthKind::Basic
        && input
            .username
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        bail!("Hermes basic authentication requires a username");
    }
    Ok(())
}

fn normalize_url(kind: RemoteGatewayKind, value: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(value.trim()).context("Invalid remote gateway URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        bail!("Gateway credentials must use the dedicated authentication fields");
    }
    url.set_fragment(None);
    match kind {
        RemoteGatewayKind::OpenClaw => match url.scheme() {
            "http" => url
                .set_scheme("ws")
                .map_err(|_| anyhow!("Invalid Gateway URL"))?,
            "https" => url
                .set_scheme("wss")
                .map_err(|_| anyhow!("Invalid Gateway URL"))?,
            "ws" | "wss" => {}
            _ => bail!("OpenClaw Gateway URL must use ws, wss, http, or https"),
        },
        RemoteGatewayKind::Hermes => match url.scheme() {
            "http" | "https" => {}
            _ => bail!("Hermes Backend URL must use http or https"),
        },
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn load_document(path: &Path) -> Result<GatewayDocument> {
    if !path.is_file() {
        return Ok(GatewayDocument {
            version: DOCUMENT_VERSION,
            gateways: Vec::new(),
            original_hash: None,
        });
    }
    let content = fs::read(path)?;
    let mut document: GatewayDocument = serde_json::from_slice(&content)?;
    document.original_hash = Some(format!("{:x}", Sha256::digest(&content)));
    if document.version != DOCUMENT_VERSION {
        bail!("Unsupported remote gateway document version");
    }
    Ok(document)
}

fn save_document(path: &Path, document: &GatewayDocument) -> Result<()> {
    let content = format!("{}\n", serde_json::to_string_pretty(document)?);
    let expected = document
        .original_hash
        .as_deref()
        .map(ExpectedFile::Sha256)
        .unwrap_or(ExpectedFile::Missing);
    atomic_write_checked(path, content.as_bytes(), expected)?;
    Ok(())
}

type GatewaySocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn refresh_openclaw(gateway: &mut StoredGateway) -> Result<()> {
    let identity = gateway
        .device_identity
        .get_or_insert_with(DeviceIdentity::generate)
        .clone();
    let (mut socket, _) = timeout(REQUEST_TIMEOUT, connect_async(&gateway.url))
        .await
        .context("OpenClaw Gateway connection timed out")??;
    let challenge = receive_json(&mut socket).await?;
    if challenge.get("event").and_then(Value::as_str) != Some("connect.challenge") {
        bail!("OpenClaw Gateway did not send a connect challenge");
    }
    let nonce = challenge
        .pointer("/payload/nonce")
        .and_then(Value::as_str)
        .context("OpenClaw challenge did not contain a nonce")?;
    let signed_at = challenge
        .pointer("/payload/ts")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let scopes = ["operator.read"];
    let shared_secret = gateway.secret.as_deref().unwrap_or_default();
    let auth_token =
        if gateway.auth_kind == RemoteGatewayAuthKind::Token && !shared_secret.is_empty() {
            shared_secret
        } else {
            gateway.device_token.as_deref().unwrap_or_default()
        };
    // OpenClaw v2 signs the bearer token field. Password authentication is
    // carried separately and must not be substituted into the signed token.
    let signed_token = auth_token;
    let payload = [
        "v2",
        &identity.device_id,
        OPENCLAW_CLIENT_ID,
        OPENCLAW_CLIENT_MODE,
        "operator",
        &scopes.join(","),
        &signed_at.to_string(),
        signed_token,
        nonce,
    ]
    .join("|");
    let signature = identity.sign(&payload)?;
    let mut auth = serde_json::Map::new();
    match gateway.auth_kind {
        RemoteGatewayAuthKind::Token => {}
        RemoteGatewayAuthKind::Password => {
            auth.insert("password".into(), shared_secret.into());
        }
        RemoteGatewayAuthKind::None => {}
        _ => bail!("Unsupported OpenClaw authentication mode"),
    }
    if !auth_token.is_empty() {
        auth.insert("token".into(), auth_token.into());
    }
    let request_id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({
                "type": "req",
                "id": request_id,
                "method": "connect",
                "params": {
                    "minProtocol": 4,
                    "maxProtocol": 4,
                    "client": {
                        "id": OPENCLAW_CLIENT_ID,
                        "version": env!("CARGO_PKG_VERSION"),
                        "platform": std::env::consts::OS,
                        "deviceFamily": "desktop",
                        "mode": OPENCLAW_CLIENT_MODE,
                        "displayName": "AgentKib"
                    },
                    "role": "operator",
                    "scopes": scopes,
                    "caps": ["agent-kind"],
                    "commands": [],
                    "permissions": {},
                    "auth": auth,
                    "locale": "en-US",
                    "userAgent": format!("agentkib/{}", env!("CARGO_PKG_VERSION")),
                    "device": {
                        "id": identity.device_id,
                        "publicKey": identity.public_key,
                        "signature": signature,
                        "signedAt": signed_at,
                        "nonce": nonce
                    }
                }
            })
            .to_string()
            .into(),
        ))
        .await?;
    let response = receive_response(&mut socket, &request_id).await?;
    if !response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let pairing_request = response
            .pointer("/error/details/requestId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if pairing_request.is_some()
            || response
                .pointer("/error/details/code")
                .and_then(Value::as_str)
                == Some("PAIRING_REQUIRED")
        {
            gateway.state = RemoteGatewayState::PairingRequired;
            gateway.pairing_request_id = pairing_request;
            gateway.last_error = None;
            return Ok(());
        }
        bail!(
            "OpenClaw connection failed: {}",
            response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown gateway error")
        );
    }
    let hello = response.get("payload").cloned().unwrap_or(Value::Null);
    gateway.version = hello
        .pointer("/server/version")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(token) = hello.pointer("/auth/deviceToken").and_then(Value::as_str) {
        gateway.device_token = Some(token.to_owned());
    }
    let methods: BTreeSet<_> = hello
        .pointer("/features/methods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let agents = rpc(&mut socket, "agents.list", json!({})).await?;
    let mut workspaces = parse_openclaw_agents(&agents);
    let mut assets = Vec::new();
    for workspace in &workspaces {
        let Some(agent_id) = workspace.agent_id.as_deref() else {
            continue;
        };
        if methods.contains("agents.files.list")
            && let Ok(files) = rpc(
                &mut socket,
                "agents.files.list",
                json!({ "agentId": agent_id }),
            )
            .await
        {
            assets.extend(parse_openclaw_files(&gateway.id, agent_id, &files));
        }
        if methods.contains("skills.status")
            && let Ok(skills) =
                rpc(&mut socket, "skills.status", json!({ "agentId": agent_id })).await
        {
            assets.extend(parse_openclaw_skills(&gateway.id, agent_id, &skills));
        }
    }
    if methods.contains("sessions.list")
        && let Ok(sessions) = rpc(&mut socket, "sessions.list", json!({ "limit": 500 })).await
    {
        merge_openclaw_sessions(&mut workspaces, &sessions);
    }
    gateway.session_count = workspaces
        .iter()
        .map(|workspace| workspace.session_count)
        .sum();
    gateway.capabilities = [
        "agents.list",
        "sessions.list",
        "agents.files.list",
        "skills.status",
        "usage.cost",
    ]
    .into_iter()
    .filter(|method| methods.contains(*method))
    .map(str::to_owned)
    .collect();
    gateway.workspaces = workspaces;
    gateway.assets = assets;
    gateway.state = RemoteGatewayState::Connected;
    gateway.pairing_request_id = None;
    gateway.last_error = None;
    gateway.last_connected_at = Some(Utc::now());
    let _ = socket.close(None).await;
    Ok(())
}

impl DeviceIdentity {
    fn generate() -> Self {
        let key = SigningKey::generate(&mut OsRng);
        let public = key.verifying_key().to_bytes();
        Self {
            device_id: hex_string(&Sha256::digest(public)),
            public_key: URL_SAFE_NO_PAD.encode(public),
            private_key: URL_SAFE_NO_PAD.encode(key.to_bytes()),
        }
    }

    fn sign(&self, payload: &str) -> Result<String> {
        let bytes = URL_SAFE_NO_PAD.decode(&self.private_key)?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("Invalid stored OpenClaw device key"))?;
        let signature = SigningKey::from_bytes(&bytes).sign(payload.as_bytes());
        Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }
}

fn hex_string(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

async fn receive_json(socket: &mut GatewaySocket) -> Result<Value> {
    loop {
        let message = timeout(REQUEST_TIMEOUT, socket.next())
            .await
            .context("Gateway response timed out")?
            .context("Gateway closed the connection")??;
        match message {
            Message::Text(text) => return Ok(serde_json::from_str(&text)?),
            Message::Ping(value) => socket.send(Message::Pong(value)).await?,
            Message::Close(reason) => bail!("Gateway closed the connection: {reason:?}"),
            _ => {}
        }
    }
}

async fn receive_response(socket: &mut GatewaySocket, id: &str) -> Result<Value> {
    loop {
        let value = receive_json(socket).await?;
        if value.get("type").and_then(Value::as_str) == Some("res")
            && value.get("id").and_then(Value::as_str) == Some(id)
        {
            return Ok(value);
        }
    }
}

async fn rpc(socket: &mut GatewaySocket, method: &str, params: Value) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({ "type": "req", "id": id, "method": method, "params": params })
                .to_string()
                .into(),
        ))
        .await?;
    let response = receive_response(socket, &id).await?;
    if !response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        bail!(
            "Gateway method {method} failed: {}",
            response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        );
    }
    Ok(response.get("payload").cloned().unwrap_or(Value::Null))
}

fn parse_openclaw_agents(value: &Value) -> Vec<RemoteGatewayWorkspace> {
    object_array(value, "agents")
        .into_iter()
        .filter_map(|agent| {
            if agent.get("kind").and_then(Value::as_str) == Some("system") {
                return None;
            }
            let id = string_field(agent, &["id", "agentId"])?;
            let name = string_field(agent, &["name", "displayName"]).unwrap_or_else(|| id.clone());
            let path = string_field(agent, &["workspace", "workspacePath", "cwd"]);
            Some(RemoteGatewayWorkspace {
                id: format!("openclaw:{id}"),
                agent_id: Some(id),
                name,
                path,
                session_count: 0,
                last_active_at: None,
            })
        })
        .collect()
}

fn parse_openclaw_files(
    gateway_id: &str,
    agent_id: &str,
    value: &Value,
) -> Vec<RemoteGatewayAsset> {
    object_array(value, "files")
        .into_iter()
        .filter(|file| file.get("exists").and_then(Value::as_bool) != Some(false))
        .filter_map(|file| {
            let path = string_field(file, &["path", "relativePath", "name"])?;
            let name = string_field(file, &["name"])
                .or_else(|| path.rsplit('/').next().map(str::to_owned))?;
            Some(RemoteGatewayAsset {
                id: stable_id(&[gateway_id, agent_id, "file", &path]),
                agent_id: Some(agent_id.to_owned()),
                kind: classify_asset(&name).to_owned(),
                name,
                path,
                size: file.get("size").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

fn parse_openclaw_skills(
    gateway_id: &str,
    agent_id: &str,
    value: &Value,
) -> Vec<RemoteGatewayAsset> {
    object_array(value, "skills")
        .into_iter()
        .filter_map(|skill| {
            let name = string_field(skill, &["name", "id", "key"])?;
            let path = string_field(skill, &["filePath", "path", "baseDir", "source"])
                .unwrap_or_else(|| format!("skills/{name}"));
            Some(RemoteGatewayAsset {
                id: stable_id(&[gateway_id, agent_id, "skill", &name]),
                agent_id: Some(agent_id.to_owned()),
                kind: "skill".into(),
                name,
                path,
                size: 0,
            })
        })
        .collect()
}

fn merge_openclaw_sessions(workspaces: &mut Vec<RemoteGatewayWorkspace>, value: &Value) {
    for session in object_array(value, "sessions") {
        let agent_id = string_field(session, &["agentId", "agent_id"]);
        let path = string_field(session, &["workspace", "cwd", "repoRoot"]);
        let timestamp = time_field(session, &["updatedAt", "lastActiveAt", "createdAt"]);
        if let Some(existing) = workspaces.iter_mut().find(|workspace| {
            workspace.agent_id == agent_id && (path.is_none() || workspace.path == path)
        }) {
            existing.session_count += 1;
            existing.last_active_at = latest(existing.last_active_at, timestamp);
        } else if path.is_some() {
            let name = path
                .as_deref()
                .and_then(|value| value.trim_end_matches('/').rsplit('/').next())
                .unwrap_or("Workspace")
                .to_owned();
            workspaces.push(RemoteGatewayWorkspace {
                id: stable_id(&[
                    "openclaw-session",
                    agent_id.as_deref().unwrap_or("default"),
                    path.as_deref().unwrap_or(""),
                ]),
                agent_id,
                name,
                path,
                session_count: 1,
                last_active_at: timestamp,
            });
        }
    }
}

async fn refresh_hermes(gateway: &mut StoredGateway) -> Result<()> {
    let client = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(REQUEST_TIMEOUT)
        .build()?;
    let base = gateway.url.trim_end_matches('/');
    if gateway.auth_kind == RemoteGatewayAuthKind::Basic {
        let username = gateway
            .username
            .as_deref()
            .context("Hermes username is missing")?;
        let password = gateway
            .secret
            .as_deref()
            .context("Hermes password is missing")?;
        let response = client
            .post(format!("{base}/auth/password-login"))
            .json(&json!({ "provider": "basic", "username": username, "password": password }))
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("Hermes authentication failed ({})", response.status());
        }
    }
    let mut headers = HeaderMap::new();
    if gateway.auth_kind == RemoteGatewayAuthKind::SessionToken {
        let secret = gateway
            .secret
            .as_deref()
            .context("Hermes session token is missing")?;
        headers.insert("X-Hermes-Session-Token", HeaderValue::from_str(secret)?);
    }
    let status_response = client
        .get(format!("{base}/api/status"))
        .headers(headers.clone())
        .send()
        .await?;
    if !status_response.status().is_success() {
        bail!("Hermes Backend returned {}", status_response.status());
    }
    let status: Value = status_response.json().await?;
    gateway.version = string_field(&status, &["version", "hermes_version"]);
    let sessions_response = client
        .get(format!("{base}/api/sessions"))
        .headers(headers)
        .send()
        .await?;
    let (sessions, sessions_available) = if sessions_response.status().is_success() {
        (sessions_response.json::<Value>().await?, true)
    } else {
        (Value::Null, false)
    };
    let session_rows = hermes_session_rows(&sessions);
    gateway.session_count = session_rows.len() as u64;
    gateway.workspaces = parse_hermes_sessions(&sessions);
    gateway.assets = hermes_ws_assets(&client, gateway).await.unwrap_or_default();
    gateway.capabilities = vec!["status".into()];
    if sessions_available {
        gateway.capabilities.push("sessions".into());
    }
    if !gateway.assets.is_empty() {
        gateway.capabilities.push("commands.catalog".into());
    }
    gateway.state = RemoteGatewayState::Connected;
    gateway.pairing_request_id = None;
    gateway.last_error = None;
    gateway.last_connected_at = Some(Utc::now());
    Ok(())
}

async fn hermes_ws_assets(
    client: &reqwest::Client,
    gateway: &StoredGateway,
) -> Result<Vec<RemoteGatewayAsset>> {
    let (auth_name, auth_value) = match gateway.auth_kind {
        RemoteGatewayAuthKind::Basic => {
            let response = client
                .post(format!(
                    "{}/api/auth/ws-ticket",
                    gateway.url.trim_end_matches('/')
                ))
                .send()
                .await?;
            if !response.status().is_success() {
                bail!(
                    "Hermes WebSocket ticket request returned {}",
                    response.status()
                );
            }
            let payload: Value = response.json().await?;
            (
                "ticket",
                string_field(&payload, &["ticket"])
                    .context("Hermes ticket response was invalid")?,
            )
        }
        RemoteGatewayAuthKind::SessionToken => (
            "token",
            gateway
                .secret
                .clone()
                .context("Hermes session token is missing")?,
        ),
        RemoteGatewayAuthKind::None => return Ok(Vec::new()),
        _ => bail!("Unsupported Hermes authentication mode"),
    };
    let mut url = reqwest::Url::parse(&gateway.url)?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| anyhow!("Invalid Hermes WebSocket URL"))?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/api/ws"));
    url.query_pairs_mut().append_pair(auth_name, &auth_value);
    let (mut socket, _) = timeout(REQUEST_TIMEOUT, connect_async(url.as_str()))
        .await
        .context("Hermes Gateway connection timed out")??;
    let catalog = hermes_rpc(&mut socket, "commands.catalog", json!({})).await?;
    let _ = socket.close(None).await;
    Ok(parse_hermes_skills(&gateway.id, &catalog))
}

async fn hermes_rpc(socket: &mut GatewaySocket, method: &str, params: Value) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    socket
        .send(Message::Text(
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
                .to_string()
                .into(),
        ))
        .await?;
    loop {
        let message = timeout(REQUEST_TIMEOUT, socket.next())
            .await
            .context("Hermes Gateway response timed out")?
            .context("Hermes Gateway closed the connection")??;
        match message {
            Message::Text(text) => {
                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                    let value: Value = serde_json::from_str(line)?;
                    if value.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                        continue;
                    }
                    if let Some(error) = value.get("error") {
                        bail!(
                            "Hermes Gateway method {method} failed: {}",
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown error")
                        );
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            Message::Ping(value) => socket.send(Message::Pong(value)).await?,
            Message::Close(reason) => bail!("Hermes Gateway closed the connection: {reason:?}"),
            _ => {}
        }
    }
}

fn parse_hermes_skills(gateway_id: &str, value: &Value) -> Vec<RemoteGatewayAsset> {
    value
        .get("skills")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(command, info)| {
            let name = command.trim_start_matches('/').to_owned();
            let origin = info.get("origin");
            let path = origin
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    origin.and_then(|value| {
                        string_field(value, &["path", "source", "root", "directory"])
                    })
                })
                .unwrap_or_else(|| format!("remote://hermes/skills/{name}"));
            RemoteGatewayAsset {
                id: stable_id(&[gateway_id, "skill", &name]),
                agent_id: None,
                kind: "skill".into(),
                name,
                path,
                size: 0,
            }
        })
        .collect()
}

fn parse_hermes_sessions(value: &Value) -> Vec<RemoteGatewayWorkspace> {
    let mut grouped = BTreeMap::<String, RemoteGatewayWorkspace>::new();
    for session in hermes_session_rows(value) {
        let path = string_field(
            session,
            &["git_repo_root", "gitRepoRoot", "cwd", "workspace"],
        );
        let Some(path) = path else {
            continue;
        };
        let key = path.clone();
        let timestamp = time_field(
            session,
            &["updated_at", "updatedAt", "created_at", "createdAt"],
        );
        let entry = grouped.entry(key.clone()).or_insert_with(|| {
            let name = path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("Workspace")
                .to_owned();
            RemoteGatewayWorkspace {
                id: stable_id(&["hermes", &key]),
                agent_id: None,
                name,
                path: Some(path),
                session_count: 0,
                last_active_at: None,
            }
        });
        entry.session_count += 1;
        entry.last_active_at = latest(entry.last_active_at, timestamp);
    }
    grouped.into_values().collect()
}

fn hermes_session_rows(value: &Value) -> Vec<&Value> {
    let sessions = object_array(value, "sessions");
    if sessions.is_empty() {
        object_array(value, "data")
    } else {
        sessions
    }
}

fn object_array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .into_iter()
        .flatten()
        .collect()
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
}

fn time_field(value: &Value, keys: &[&str]) -> Option<DateTime<Utc>> {
    for key in keys {
        let Some(value) = value.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str()
            && let Ok(parsed) = DateTime::parse_from_rfc3339(text)
        {
            return Some(parsed.with_timezone(&Utc));
        }
        if let Some(number) = value.as_i64() {
            let milliseconds = if number < 10_000_000_000 {
                number * 1000
            } else {
                number
            };
            if let Some(parsed) = DateTime::from_timestamp_millis(milliseconds) {
                return Some(parsed);
            }
        }
    }
    None
}

fn latest(left: Option<DateTime<Utc>>, right: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn classify_asset(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("skill") {
        "skill"
    } else if lower.contains("mcp") {
        "connection"
    } else if lower.contains("memory") {
        "memory"
    } else if lower.contains("hook") {
        "hook"
    } else {
        "instruction"
    }
}

fn stable_id(parts: &[&str]) -> String {
    hex_string(&Sha256::digest(parts.join("\0").as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_gateway_urls_by_provider() {
        assert_eq!(
            normalize_url(RemoteGatewayKind::OpenClaw, "https://gateway.test/").unwrap(),
            "wss://gateway.test"
        );
        assert_eq!(
            normalize_url(RemoteGatewayKind::Hermes, "http://server:9119/").unwrap(),
            "http://server:9119"
        );
        assert!(
            normalize_url(RemoteGatewayKind::Hermes, "https://user:secret@server:9119").is_err()
        );
        assert!(
            normalize_url(
                RemoteGatewayKind::OpenClaw,
                "wss://gateway.test/?token=secret"
            )
            .is_err()
        );
    }

    #[test]
    fn private_registry_never_exposes_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateways.json");
        let document = GatewayDocument {
            version: DOCUMENT_VERSION,
            gateways: vec![StoredGateway {
                id: "one".into(),
                kind: RemoteGatewayKind::OpenClaw,
                name: "Server".into(),
                url: "wss://example.test".into(),
                auth_kind: RemoteGatewayAuthKind::Token,
                username: None,
                secret: Some("super-secret".into()),
                device_identity: None,
                device_token: None,
                state: RemoteGatewayState::Pending,
                version: None,
                capabilities: Vec::new(),
                session_count: 0,
                workspaces: Vec::new(),
                assets: Vec::new(),
                pairing_request_id: None,
                last_connected_at: None,
                last_error: None,
            }],
            original_hash: None,
        };
        save_document(&path, &document).unwrap();
        let json = serde_json::to_string(&list(&path).unwrap()).unwrap();
        assert!(!json.contains("super-secret"));
        assert!(json.contains("has_credentials"));
    }

    #[test]
    fn registry_write_rejects_an_external_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateways.json");
        let initial = GatewayDocument {
            version: DOCUMENT_VERSION,
            gateways: Vec::new(),
            original_hash: None,
        };
        save_document(&path, &initial).unwrap();
        let loaded = load_document(&path).unwrap();
        fs::write(&path, "{\"version\":1,\"gateways\":[]}\n").unwrap();
        assert!(save_document(&path, &loaded).is_err());
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "{\"version\":1,\"gateways\":[]}\n"
        );
    }

    #[test]
    fn groups_hermes_sessions_without_retaining_titles() {
        let value = json!({ "sessions": [
            { "cwd": "/srv/app", "title": "private prompt", "updated_at": "2026-08-14T00:00:00Z" },
            { "cwd": "/srv/app", "title": "another prompt", "updated_at": "2026-08-14T01:00:00Z" }
        ] });
        let workspaces = parse_hermes_sessions(&value);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].session_count, 2);
        assert!(!format!("{workspaces:?}").contains("private prompt"));
    }

    #[test]
    fn counts_hermes_rest_rows_without_inventing_workspace_paths() {
        let value = json!({ "data": [
            { "id": "private-session-id", "title": "private prompt", "last_active": "2026-08-14T00:00:00Z" }
        ] });
        assert_eq!(hermes_session_rows(&value).len(), 1);
        assert!(parse_hermes_sessions(&value).is_empty());
    }

    #[test]
    fn imports_only_hermes_skill_metadata_from_the_command_catalog() {
        let value = json!({
            "skills": {
                "/review": { "usage": 4, "origin": { "path": "/srv/hermes/skills/review" } },
                "/plan": { "usage": 2, "origin": "bundled" }
            },
            "pairs": [["/review", "private description"]]
        });
        let assets = parse_hermes_skills("gateway", &value);
        assert_eq!(assets.len(), 2);
        assert!(assets.iter().any(|asset| asset.name == "review"));
        assert!(!format!("{assets:?}").contains("private description"));
    }
}
