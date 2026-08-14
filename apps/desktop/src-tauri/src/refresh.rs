use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const QUOTA_QUEUE_TIMEOUT: Duration = Duration::from_secs(2);

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
    Backoff,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshReceipt {
    pub kind: RefreshKind,
    pub disposition: RefreshDisposition,
    pub request_id: String,
    pub status: RefreshJobStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshJobStatus {
    pub kind: RefreshKind,
    pub state: RefreshState,
    pub request_id: Option<String>,
    pub queued_at: Option<DateTime<Utc>>,
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
                queued_at: None,
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
    quota_lane: Arc<Semaphore>,
    background_lane: Arc<Semaphore>,
    disk_heavy_lane: Arc<Semaphore>,
    write_lock: Arc<Mutex<()>>,
    tray_refresh_pending: AtomicBool,
    accepting: AtomicBool,
    sequence: AtomicU64,
}

impl Default for RefreshCoordinator {
    fn default() -> Self {
        Self::with_parallelism(
            std::thread::available_parallelism()
                .map(|value| value.get())
                .unwrap_or(2),
        )
    }
}

impl RefreshCoordinator {
    fn with_parallelism(parallelism: usize) -> Self {
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
            quota_lane: Arc::new(Semaphore::new(1)),
            background_lane: Arc::new(Semaphore::new(background_concurrency(parallelism))),
            disk_heavy_lane: Arc::new(Semaphore::new(1)),
            write_lock: Arc::new(Mutex::new(())),
            tray_refresh_pending: AtomicBool::new(false),
            accepting: AtomicBool::new(true),
            sequence: AtomicU64::new(1),
        }
    }

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
        let receipt = self.reserve(kind, request_id, now, force);
        let disposition = receipt.disposition;
        if disposition == RefreshDisposition::Queued {
            self.emit_status(&app, kind);
            self.schedule_tray_refresh(&app);

            let worker_coordinator = Arc::clone(self);
            let worker_app = app.clone();
            let worker_request_id = receipt.request_id.clone();
            let worker = tauri::async_runtime::spawn(async move {
                worker_coordinator
                    .execute(worker_app, kind, &worker_request_id)
                    .await
            });

            let supervisor = Arc::clone(self);
            let supervisor_request_id = receipt.request_id.clone();
            tauri::async_runtime::spawn(async move {
                let result = join_refresh_worker(worker).await;
                supervisor.finish(&app, kind, &supervisor_request_id, result);
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
        let should_request = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned")
            .get(&kind)
            .is_some_and(|record| {
                matches!(
                    record.status.state,
                    RefreshState::Failed | RefreshState::Backoff
                ) || record
                    .status
                    .finished_at
                    .is_none_or(|finished| Utc::now() - finished >= max_age)
            });
        should_request.then(|| self.request(app, kind, false))
    }

    pub fn shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        self.quota_lane.close();
        self.background_lane.close();
        self.disk_heavy_lane.close();
    }

    pub fn is_accepting(&self) -> bool {
        self.accepting.load(Ordering::SeqCst)
    }

    pub fn seed_finished_at(&self, kind: RefreshKind, finished_at: Option<DateTime<Utc>>) {
        if let Some(finished_at) = finished_at {
            self.update(kind, |record| {
                record.status.state = RefreshState::Succeeded;
                record.status.finished_at = Some(finished_at);
            });
        }
    }

    fn reserve(
        &self,
        kind: RefreshKind,
        request_id: String,
        now: DateTime<Utc>,
        force: bool,
    ) -> RefreshReceipt {
        let mut jobs = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned");
        let record = jobs
            .get_mut(&kind)
            .expect("refresh kind must be registered");
        if !self.accepting.load(Ordering::SeqCst) {
            return receipt(kind, RefreshDisposition::AlreadyRunning, request_id, record);
        }
        if matches!(
            record.status.state,
            RefreshState::Queued | RefreshState::Running
        ) {
            let active_request_id = record.status.request_id.clone().unwrap_or(request_id);
            return receipt(
                kind,
                RefreshDisposition::AlreadyRunning,
                active_request_id,
                record,
            );
        }
        if !force && record.status.next_allowed_at.is_some_and(|next| next > now) {
            record.status.state = RefreshState::Backoff;
            return receipt(kind, RefreshDisposition::Backoff, request_id, record);
        }
        record.status.state = RefreshState::Queued;
        record.status.request_id = Some(request_id.clone());
        record.status.queued_at = Some(now);
        record.status.started_at = None;
        record.status.finished_at = None;
        record.status.progress_current = Some(0);
        record.status.progress_total = Some(1);
        record.status.error = None;
        receipt(kind, RefreshDisposition::Queued, request_id, record)
    }

    async fn execute(
        self: Arc<Self>,
        app: AppHandle,
        kind: RefreshKind,
        request_id: &str,
    ) -> anyhow::Result<()> {
        let mut _quota_permit = None;
        let mut _background_permit = None;
        let mut _disk_permit = None;
        if kind == RefreshKind::Quota {
            let permit =
                acquire_quota_permit(Arc::clone(&self.quota_lane), QUOTA_QUEUE_TIMEOUT).await?;
            _quota_permit = Some(permit);
        } else {
            let permit = Arc::clone(&self.background_lane)
                .acquire_owned()
                .await
                .map_err(|_| anyhow::anyhow!("background refresh lane is closed"))?;
            _background_permit = Some(permit);
            if matches!(kind, RefreshKind::Discovery | RefreshKind::Insights) {
                let permit = Arc::clone(&self.disk_heavy_lane)
                    .acquire_owned()
                    .await
                    .map_err(|_| anyhow::anyhow!("disk refresh lane is closed"))?;
                _disk_permit = Some(permit);
            }
        }
        if !self.accepting.load(Ordering::SeqCst) {
            anyhow::bail!("refresh coordinator is shutting down");
        }
        if !self.update_active(kind, request_id, |record| {
            record.status.state = RefreshState::Running;
            record.status.started_at = Some(Utc::now());
        }) {
            anyhow::bail!("refresh request was superseded");
        }
        self.emit_status(&app, kind);
        self.schedule_tray_refresh(&app);

        let blocking_app = app.clone();
        let write_lock = Arc::clone(&self.write_lock);
        tauri::async_runtime::spawn_blocking(move || {
            super::run_refresh_job(&blocking_app, kind, &write_lock)
        })
        .await
        .map_err(|error| anyhow::anyhow!("refresh worker join failed: {error}"))
        .and_then(|result| result)
    }

    fn finish(
        self: &Arc<Self>,
        app: &AppHandle,
        kind: RefreshKind,
        request_id: &str,
        result: anyhow::Result<()>,
    ) {
        if !self.complete_active(kind, request_id, result) {
            return;
        }
        self.emit_status(app, kind);
        self.schedule_tray_refresh(app);
    }

    fn complete_active(
        &self,
        kind: RefreshKind,
        request_id: &str,
        result: anyhow::Result<()>,
    ) -> bool {
        let now = Utc::now();
        self.update_active(kind, request_id, |record| match result {
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
        })
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

    fn update_active(
        &self,
        kind: RefreshKind,
        request_id: &str,
        update: impl FnOnce(&mut JobRecord),
    ) -> bool {
        let mut jobs = self
            .jobs
            .lock()
            .expect("refresh job state lock is poisoned");
        let record = jobs
            .get_mut(&kind)
            .expect("refresh kind must be registered");
        if record.status.request_id.as_deref() != Some(request_id) {
            return false;
        }
        update(record);
        true
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

    fn schedule_tray_refresh(self: &Arc<Self>, app: &AppHandle) {
        if self.tray_refresh_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let coordinator = Arc::clone(self);
        let main_app = app.clone();
        if app
            .run_on_main_thread(move || {
                coordinator
                    .tray_refresh_pending
                    .store(false, Ordering::SeqCst);
                let _ = super::refresh_tray_status(&main_app);
            })
            .is_err()
        {
            self.tray_refresh_pending.store(false, Ordering::SeqCst);
        }
    }
}

async fn acquire_quota_permit(
    lane: Arc<Semaphore>,
    timeout: Duration,
) -> anyhow::Result<OwnedSemaphorePermit> {
    tokio::time::timeout(timeout, lane.acquire_owned())
        .await
        .map_err(|_| anyhow::anyhow!("quota refresh queue timed out"))?
        .map_err(|_| anyhow::anyhow!("quota refresh lane is closed"))
}

async fn join_refresh_worker(
    worker: tauri::async_runtime::JoinHandle<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    worker
        .await
        .map_err(|error| anyhow::anyhow!("refresh task failed: {error}"))
        .and_then(|result| result)
}

fn receipt(
    kind: RefreshKind,
    disposition: RefreshDisposition,
    request_id: String,
    record: &JobRecord,
) -> RefreshReceipt {
    RefreshReceipt {
        kind,
        disposition,
        request_id,
        status: record.status.clone(),
    }
}

fn background_concurrency(parallelism: usize) -> usize {
    if parallelism <= 4 { 1 } else { 2 }
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
            coordinator
                .reserve(RefreshKind::Insights, "first".into(), now, true)
                .disposition,
            RefreshDisposition::Queued,
        );
        assert_eq!(
            coordinator
                .reserve(RefreshKind::Insights, "second".into(), now, true)
                .disposition,
            RefreshDisposition::AlreadyRunning,
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
            coordinator
                .reserve(RefreshKind::Discovery, "automatic".into(), now, false)
                .disposition,
            RefreshDisposition::Backoff
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
            coordinator
                .reserve(RefreshKind::Discovery, "manual".into(), now, true)
                .disposition,
            RefreshDisposition::Queued,
        );
    }

    #[test]
    fn background_concurrency_is_conservative() {
        assert_eq!(background_concurrency(1), 1);
        assert_eq!(background_concurrency(4), 1);
        assert_eq!(background_concurrency(5), 2);
        assert_eq!(background_concurrency(64), 2);
    }

    #[test]
    fn duplicate_receipt_uses_the_active_request() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        coordinator.reserve(RefreshKind::Quota, "active".into(), now, false);
        let duplicate = coordinator.reserve(RefreshKind::Quota, "duplicate".into(), now, true);
        assert_eq!(duplicate.disposition, RefreshDisposition::AlreadyRunning);
        assert_eq!(duplicate.request_id, "active");
        assert_eq!(duplicate.status.state, RefreshState::Queued);
    }

    #[test]
    fn completion_only_updates_the_active_request() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        coordinator.reserve(RefreshKind::Quota, "current".into(), now, true);
        coordinator.update(RefreshKind::Quota, |record| {
            record.status.request_id = Some("replacement".into());
        });

        assert!(!coordinator.complete_active(
            RefreshKind::Quota,
            "current",
            Err(anyhow::anyhow!("stale failure")),
        ));
        let status = coordinator
            .statuses()
            .into_iter()
            .find(|status| status.kind == RefreshKind::Quota)
            .unwrap();
        assert_eq!(status.state, RefreshState::Queued);
        assert_eq!(status.request_id.as_deref(), Some("replacement"));
    }

    #[test]
    fn failed_completion_reaches_a_terminal_state() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        coordinator.reserve(RefreshKind::Quota, "failed".into(), now, true);

        assert!(coordinator.complete_active(
            RefreshKind::Quota,
            "failed",
            Err(anyhow::anyhow!("collector failed")),
        ));
        let status = coordinator
            .statuses()
            .into_iter()
            .find(|status| status.kind == RefreshKind::Quota)
            .unwrap();
        assert_eq!(status.state, RefreshState::Failed);
        assert_eq!(status.error.as_deref(), Some("collector failed"));
        assert!(status.finished_at.is_some());
    }

    #[tokio::test]
    async fn closed_and_busy_quota_lanes_return_errors() {
        let closed = Arc::new(Semaphore::new(1));
        closed.close();
        assert!(
            acquire_quota_permit(closed, Duration::from_millis(10))
                .await
                .unwrap_err()
                .to_string()
                .contains("closed")
        );

        let busy = Arc::new(Semaphore::new(0));
        assert!(
            acquire_quota_permit(busy, Duration::from_millis(10))
                .await
                .unwrap_err()
                .to_string()
                .contains("timed out")
        );
    }

    #[tokio::test]
    async fn worker_panics_are_converted_to_terminal_failures() {
        let coordinator = RefreshCoordinator::default();
        let now = Utc::now();
        coordinator.reserve(RefreshKind::Quota, "panic".into(), now, true);
        let worker = tauri::async_runtime::spawn(async move {
            panic!("collector panic");
            #[allow(unreachable_code)]
            Ok(())
        });

        let result = join_refresh_worker(worker).await;
        assert!(coordinator.complete_active(RefreshKind::Quota, "panic", result));
        let status = coordinator
            .statuses()
            .into_iter()
            .find(|status| status.kind == RefreshKind::Quota)
            .unwrap();
        assert_eq!(status.state, RefreshState::Failed);
        assert!(status.error.unwrap().contains("refresh task failed"));
    }
}
