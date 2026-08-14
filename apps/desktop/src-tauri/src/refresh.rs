use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefreshKind {
    Discovery,
    Insights,
    Gateways,
    Quota,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefreshState {
    Idle,
    Queued,
    Running,
    Succeeded,
    Failed,
    Backoff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefreshDisposition {
    Queued,
    AlreadyRunning,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshReceipt {
    pub kind: RefreshKind,
    pub disposition: RefreshDisposition,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshJobStatus {
    pub kind: RefreshKind,
    pub state: RefreshState,
    pub request_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub progress_current: Option<u64>,
    pub progress_total: Option<u64>,
    pub error: Option<String>,
    pub next_allowed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct JobRecord {
    status: RefreshJobStatus,
    failure_count: u32,
}

impl JobRecord {
    fn idle(kind: RefreshKind) -> Self {
        Self {
            status: RefreshJobStatus {
                kind,
                state: RefreshState::Idle,
                request_id: None,
                started_at: None,
                finished_at: None,
                progress_current: None,
                progress_total: None,
                error: None,
                next_allowed_at: None,
            },
            failure_count: 0,
        }
    }
}

pub struct RefreshCoordinator {
    jobs: Mutex<BTreeMap<RefreshKind, JobRecord>>,
    concurrency: Arc<Semaphore>,
    write_lock: Arc<Mutex<()>>,
    accepting: AtomicBool,
    sequence: AtomicU64,
}

impl Default for RefreshCoordinator {
    fn default() -> Self {
        let jobs = [
            RefreshKind::Discovery,
            RefreshKind::Insights,
            RefreshKind::Gateways,
            RefreshKind::Quota,
        ]
        .into_iter()
        .map(|kind| (kind, JobRecord::idle(kind)))
        .collect();
        Self {
            jobs: Mutex::new(jobs),
            concurrency: Arc::new(Semaphore::new(2)),
            write_lock: Arc::new(Mutex::new(())),
            accepting: AtomicBool::new(true),
            sequence: AtomicU64::new(1),
        }
    }
}

impl RefreshCoordinator {
    pub fn request(
        self: &Arc<Self>,
        app: AppHandle,
        kind: RefreshKind,
        force: bool,
    ) -> RefreshReceipt {
        let now = Utc::now();
        let request_id = format!(
            "{}-{}",
            now.timestamp_millis(),
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let disposition = self.reserve(kind, request_id.clone(), now, force);
        let receipt = RefreshReceipt {
            kind,
            disposition,
            request_id,
        };
        if disposition == RefreshDisposition::Queued {
            let coordinator = Arc::clone(self);
            tauri::async_runtime::spawn(async move {
                coordinator.run(app, kind).await;
            });
        }
        receipt
    }

    pub fn statuses(&self) -> Vec<RefreshJobStatus> {
        self.jobs
            .lock()
            .expect("refresh job state lock is poisoned")
            .values()
            .map(|record| record.status.clone())
            .collect()
    }

    pub fn request_if_stale(
        self: &Arc<Self>,
        app: AppHandle,
        kind: RefreshKind,
        max_age: chrono::Duration,
    ) -> Option<RefreshReceipt> {
        let fresh = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned")
            .get(&kind)
            .and_then(|record| record.status.finished_at)
            .is_some_and(|finished| Utc::now() - finished < max_age);
        (!fresh).then(|| self.request(app, kind, false))
    }

    pub fn shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
    }

    pub fn is_accepting(&self) -> bool {
        self.accepting.load(Ordering::SeqCst)
    }

    fn reserve(
        &self,
        kind: RefreshKind,
        request_id: String,
        now: DateTime<Utc>,
        force: bool,
    ) -> RefreshDisposition {
        let mut jobs = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned");
        let record = jobs
            .get_mut(&kind)
            .expect("refresh kind must be registered");
        if !self.accepting.load(Ordering::SeqCst)
            || matches!(
                record.status.state,
                RefreshState::Queued | RefreshState::Running
            )
        {
            return RefreshDisposition::AlreadyRunning;
        }
        if !force && record.status.next_allowed_at.is_some_and(|next| next > now) {
            record.status.state = RefreshState::Backoff;
            return RefreshDisposition::AlreadyRunning;
        }
        record.status.state = RefreshState::Queued;
        record.status.request_id = Some(request_id);
        record.status.started_at = None;
        record.status.finished_at = None;
        record.status.progress_current = Some(0);
        record.status.progress_total = Some(1);
        record.status.error = None;
        RefreshDisposition::Queued
    }

    async fn run(self: Arc<Self>, app: AppHandle, kind: RefreshKind) {
        self.emit_status(&app, kind);
        let _ = super::refresh_tray_status(&app);
        let Ok(_permit) = Arc::clone(&self.concurrency).acquire_owned().await else {
            return;
        };
        if !self.accepting.load(Ordering::SeqCst) {
            return;
        }
        self.update(kind, |record| {
            record.status.state = RefreshState::Running;
            record.status.started_at = Some(Utc::now());
        });
        self.emit_status(&app, kind);
        let _ = super::refresh_tray_status(&app);

        let blocking_app = app.clone();
        let write_lock = Arc::clone(&self.write_lock);
        let result = tauri::async_runtime::spawn_blocking(move || {
            super::run_refresh_job(&blocking_app, kind, &write_lock)
        })
        .await
        .map_err(|error| anyhow::anyhow!("refresh worker join failed: {error}"))
        .and_then(|result| result);

        let now = Utc::now();
        self.update(kind, |record| match result {
            Ok(()) => {
                record.failure_count = 0;
                record.status.state = RefreshState::Succeeded;
                record.status.finished_at = Some(now);
                record.status.progress_current = Some(1);
                record.status.error = None;
                record.status.next_allowed_at = None;
            }
            Err(error) => {
                record.failure_count = record.failure_count.saturating_add(1);
                let delay = backoff_delay(record.failure_count);
                record.status.state = RefreshState::Failed;
                record.status.finished_at = Some(now);
                record.status.error = Some(error.to_string());
                record.status.next_allowed_at = chrono::Duration::from_std(delay)
                    .ok()
                    .map(|delay| now + delay);
            }
        });
        self.emit_status(&app, kind);
        let _ = super::refresh_tray_status(&app);
    }

    fn update(&self, kind: RefreshKind, update: impl FnOnce(&mut JobRecord)) {
        let mut jobs = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned");
        update(
            jobs.get_mut(&kind)
                .expect("refresh kind must be registered"),
        );
    }

    fn emit_status(&self, app: &AppHandle, kind: RefreshKind) {
        let status = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned")
            .get(&kind)
            .expect("refresh kind must be registered")
            .status
            .clone();
        let _ = app.emit("agentkib:refresh-state", status);
    }
}

fn backoff_delay(failure_count: u32) -> Duration {
    match failure_count {
        0 | 1 => Duration::from_secs(5 * 60),
        2 => Duration::from_secs(15 * 60),
        3 => Duration::from_secs(30 * 60),
        _ => Duration::from_secs(60 * 60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_refresh_requests_are_coalesced() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        assert_eq!(
            coordinator.reserve(RefreshKind::Insights, "first".into(), now, true),
            RefreshDisposition::Queued
        );
        assert_eq!(
            coordinator.reserve(RefreshKind::Insights, "second".into(), now, true),
            RefreshDisposition::AlreadyRunning
        );
    }

    #[test]
    fn backoff_steps_are_bounded() {
        assert_eq!(backoff_delay(1), Duration::from_secs(5 * 60));
        assert_eq!(backoff_delay(2), Duration::from_secs(15 * 60));
        assert_eq!(backoff_delay(3), Duration::from_secs(30 * 60));
        assert_eq!(backoff_delay(99), Duration::from_secs(60 * 60));
    }

    #[test]
    fn automatic_requests_respect_backoff_but_manual_requests_can_bypass_it() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        coordinator.update(RefreshKind::Discovery, |record| {
            record.status.state = RefreshState::Failed;
            record.status.next_allowed_at = Some(now + chrono::Duration::minutes(5));
        });
        assert_eq!(
            coordinator.reserve(RefreshKind::Discovery, "automatic".into(), now, false),
            RefreshDisposition::AlreadyRunning
        );
        assert_eq!(
            coordinator
                .statuses()
                .into_iter()
                .find(|status| status.kind == RefreshKind::Discovery)
                .unwrap()
                .state,
            RefreshState::Backoff
        );
        assert_eq!(
            coordinator.reserve(RefreshKind::Discovery, "manual".into(), now, true),
            RefreshDisposition::Queued
        );
    }
}
