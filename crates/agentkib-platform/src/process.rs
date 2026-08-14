use std::io;
use std::process::Child;

/// Owns the operating-system primitive that contains a child process tree.
/// On Windows, dropping the guard terminates every process in the Job Object.
pub struct ProcessTree {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            windows::attach(child)
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    /// Attach an already-spawned process by id. This is useful for process
    /// wrappers that expose only a pid rather than the underlying `Child`.
    pub fn attach_pid(pid: u32) -> io::Result<Self> {
        #[cfg(windows)]
        {
            windows::attach_pid(pid)
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            Ok(Self {})
        }
    }

    pub fn terminate(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            windows::terminate(self.job)
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::mem;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    use super::ProcessTree;

    pub(super) fn attach(child: &Child) -> io::Result<ProcessTree> {
        attach_handle(child.as_raw_handle() as HANDLE)
    }

    pub(super) fn attach_pid(pid: u32) -> io::Result<ProcessTree> {
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = attach_handle(process);
        unsafe { CloseHandle(process) };
        result
    }

    fn attach_handle(process: HANDLE) -> io::Result<ProcessTree> {
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const _,
                mem::size_of_val(&information) as u32,
            )
        };
        if configured == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        if unsafe { AssignProcessToJobObject(job, process) } == 0 {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(ProcessTree { job })
    }

    pub(super) fn terminate(job: HANDLE) -> io::Result<()> {
        if unsafe { TerminateJobObject(job, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
