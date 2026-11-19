//! The lifetime of every agent CLI process this app starts.
//!
//! An agent CLI spends the user's tokens for as long as it runs and, while a
//! Flow Tool Server session is open, can edit the flow. So no process is
//! started without an owner that can end it. [`AgentCliRuns`] starts every one,
//! and is the one place a process is ended:
//!
//! - the turn it runs for is stopped: [`AgentCliRuns::stop`];
//! - the page that asked for it is gone (a reload): [`AgentCliRuns::stop_all`];
//! - the app quits: [`AgentCliRuns::shutdown`];
//! - the future waiting on it is dropped.
//!
//! A process that exits by itself is left as it ended, with whatever it left
//! behind.
//!
//! # A run has a name, and a stop names its run
//!
//! The webview names each run when it starts it and stops it by that name, so a
//! stop that arrives late (its run is over, another is going) finds nothing to
//! end. A stop can also arrive early: two commands invoked one after the other
//! are not polled in that order. A stop for a name that is not running is
//! therefore kept, and a run that starts under that name is not started.
//!
//! # Ending a process means ending everything it started
//!
//! An agent CLI starts processes of its own: the relay to this app's MCP
//! server, and whatever its tools run. Ending only the process this app
//! spawned would leave those running.
//!
//! - **unix**: the process is started as the leader of its own process group.
//!   Ending asks the group first (`SIGTERM`), because a CLI that is asked ends
//!   the processes it moved out of its group, which a kill cannot reach. A
//!   group that has not ended within the grace is killed (`SIGKILL`).
//! - **Windows**: the process is put in a job object, which every process it
//!   starts joins. Ending terminates the job. Windows has no signal to ask
//!   with, so there is no grace. The job is also terminated when its handle
//!   closes, which is what the OS does if this app dies.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::process::{Output, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

/// How long a process that was asked to end has before it is killed.
///
/// Long enough for a CLI to end its own child processes and close its session
/// file, short enough that a stop still reads as a stop. It is also the longest
/// [`AgentCliRuns::shutdown`] holds up the app quitting.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// How many stops for runs that have not started are kept. A stop that
/// overtakes its run is rare and its run follows at once, so the oldest one
/// dropped here is a stop for a run that had already ended.
const EARLY_STOPS: usize = 32;

/// How a run ended.
#[derive(Debug)]
pub enum Ended {
    /// The process exited by itself: its status and everything it wrote.
    Exited(Output),
    /// The process was ended, or never started because its stop came first.
    /// Nothing it wrote is kept.
    Stopped,
}

/// Why a run could not be seen through.
#[derive(Debug)]
pub enum Failure {
    /// The process could not be started, or could not be owned once started.
    Start(io::Error),
    /// Its stdin could not be written.
    Stdin(io::Error),
    /// It could not be waited on, or its output could not be read.
    Wait(io::Error),
}

/// Every agent CLI process that is running, by the name of its run.
pub struct AgentCliRuns {
    shared: Arc<Shared>,
    grace: Duration,
}

impl Default for AgentCliRuns {
    fn default() -> Self {
        Self::with_grace(STOP_GRACE)
    }
}

struct Shared {
    table: Mutex<Table>,
    /// Notified each time a run leaves the table.
    left: Condvar,
}

impl Shared {
    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[derive(Default)]
struct Table {
    running: HashMap<String, Running>,
    /// Stops for names that were not running, oldest first.
    early_stops: VecDeque<String>,
}

/// A running process, as the table holds it: enough to end it.
struct Running {
    tree: Arc<Tree>,
    stop: Arc<Notify>,
}

impl Running {
    /// Ask the process tree to end, and tell the future waiting on it to see
    /// that it does.
    fn end(&self) {
        self.tree.ask();
        self.stop.notify_one();
    }
}

/// A run's place in the table. Dropping it takes the run out of the table, and
/// kills the process tree unless the run is already over.
struct Registered {
    shared: Arc<Shared>,
    name: String,
    tree: Arc<Tree>,
    stop: Arc<Notify>,
    over: bool,
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.shared.table().running.remove(&self.name);
        if !self.over {
            self.tree.kill();
        }
        self.shared.left.notify_all();
    }
}

impl AgentCliRuns {
    /// An owner that kills a process `grace` after asking it to end.
    #[must_use]
    pub fn with_grace(grace: Duration) -> Self {
        Self {
            shared: Arc::new(Shared { table: Mutex::new(Table::default()), left: Condvar::new() }),
            grace,
        }
    }

    /// Run `command` as the run `name`: write `stdin`, close it, and wait for
    /// the process to end.
    ///
    /// Resolves with [`Ended::Exited`] when the process exits by itself, and
    /// with [`Ended::Stopped`] when it was ended first. Dropping the future
    /// kills the process and everything it started.
    pub async fn run(
        &self,
        name: &str,
        mut command: Command,
        stdin: &[u8],
    ) -> Result<Ended, Failure> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        Tree::prepare(&mut command);

        let Some((mut child, mut run)) = self.start(name, &mut command)? else {
            return Ok(Ended::Stopped);
        };

        // A stop wins over an exit that lands with it: whoever stopped the run
        // is not waiting for its answer.
        let exited = tokio::select! {
            biased;
            () = run.stop.notified() => None,
            output = collect(&mut child, stdin) => Some(output),
        };

        if let Some(output) = exited {
            let output = output?;
            run.tree.release();
            run.over = true;
            return Ok(Ended::Exited(output));
        }

        // The tree was asked to end when the stop was made. Its leader gets
        // the grace to do so; whatever is left of the tree is then killed.
        let _ = tokio::time::timeout(self.grace, child.wait()).await;
        run.tree.kill();
        let _ = child.start_kill();
        let _ = child.wait().await;
        run.over = true;
        Ok(Ended::Stopped)
    }

    /// Start the process and put it in the table, or `None` when the run was
    /// stopped before it could start.
    ///
    /// One lock covers the check for an early stop, the spawn and the insert,
    /// so a stop made at any moment either stops the run from starting or finds
    /// it in the table.
    fn start(
        &self,
        name: &str,
        command: &mut Command,
    ) -> Result<Option<(Child, Registered)>, Failure> {
        let mut table = self.shared.table();
        if let Some(at) = table.early_stops.iter().position(|stopped| stopped == name) {
            table.early_stops.remove(at);
            return Ok(None);
        }
        if table.running.contains_key(name) {
            return Err(Failure::Start(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "a run of this name is already going",
            )));
        }

        // `kill_on_drop` ends the process if it cannot be owned.
        let child = command.spawn().map_err(Failure::Start)?;
        let tree = Arc::new(Tree::adopt(&child).map_err(Failure::Start)?);
        let stop = Arc::new(Notify::new());
        table
            .running
            .insert(name.to_owned(), Running { tree: Arc::clone(&tree), stop: Arc::clone(&stop) });
        Ok(Some((
            child,
            Registered {
                shared: Arc::clone(&self.shared),
                name: name.to_owned(),
                tree,
                stop,
                over: false,
            },
        )))
    }

    /// End the run `name`, and everything its process started.
    ///
    /// A name that is not running is remembered, so a run that starts under it
    /// afterwards is not started. A run that is already over is not affected,
    /// and neither is any other run.
    pub fn stop(&self, name: &str) {
        let mut table = self.shared.table();
        if let Some(running) = table.running.get(name) {
            running.end();
            return;
        }
        if table.early_stops.len() == EARLY_STOPS {
            table.early_stops.pop_front();
        }
        table.early_stops.push_back(name.to_owned());
    }

    /// End every run. For when whoever asked for them is gone and can no
    /// longer stop them by name.
    pub fn stop_all(&self) {
        for running in self.shared.table().running.values() {
            running.end();
        }
    }

    /// End every run and do not return before each process tree is dead or
    /// killed. For the moment the app quits, after which nothing here runs
    /// again.
    ///
    /// Blocks for at most the grace. It does not depend on the async runtime:
    /// what has not ended within the grace is killed from here.
    pub fn shutdown(&self) {
        let mut table = self.shared.table();
        for running in table.running.values() {
            running.end();
        }
        let deadline = Instant::now() + self.grace;
        while !table.running.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            table = self
                .shared
                .left
                .wait_timeout(table, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        for running in table.running.values() {
            running.tree.kill();
        }
    }
}

/// Write the process its stdin, then wait for it to exit and for both of its
/// output pipes to close.
///
/// The pipe is closed after the write: without that these CLIs sit waiting for
/// more input.
async fn collect(child: &mut Child, stdin: &[u8]) -> Result<Output, Failure> {
    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(stdin).await.map_err(Failure::Stdin)?;
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let (status, stdout, stderr) =
        tokio::try_join!(child.wait(), drain(stdout.as_mut()), drain(stderr.as_mut()))
            .map_err(Failure::Wait)?;
    Ok(Output { status, stdout, stderr })
}

async fn drain(pipe: Option<&mut (impl AsyncRead + Unpin)>) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    if let Some(pipe) = pipe {
        pipe.read_to_end(&mut bytes).await?;
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// The process tree, per platform
// ---------------------------------------------------------------------------

/// A process and everything it started, as one thing that can be ended.
#[cfg(unix)]
struct Tree {
    /// The process group the process leads. Its id is the leader's pid.
    group: libc::pid_t,
}

#[cfg(unix)]
impl Tree {
    /// Start the process as the leader of a new process group, which every
    /// process it starts is in unless that process leaves it.
    fn prepare(command: &mut Command) {
        command.process_group(0);
    }

    fn adopt(child: &Child) -> io::Result<Self> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("the process ended before it could be owned"))?;
        Ok(Self { group: pid as libc::pid_t })
    }

    /// Ask every process in the group to end.
    fn ask(&self) {
        self.signal(libc::SIGTERM);
    }

    /// Kill every process in the group.
    fn kill(&self) {
        self.signal(libc::SIGKILL);
    }

    /// Leave whatever is left of the group running.
    fn release(&self) {}

    fn signal(&self, signal: libc::c_int) {
        // SAFETY: `killpg` takes two integers and touches no memory. A group
        // with no process left in it is an error the call reports (`ESRCH`),
        // which is the outcome wanted.
        unsafe {
            libc::killpg(self.group, signal);
        }
    }
}

/// A process and everything it started, as one thing that can be ended.
#[cfg(windows)]
struct Tree {
    /// The job object the process was put in.
    job: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: a job object handle is a kernel handle. Every call made on it here is
// safe from any thread, and it is closed once, on drop.
#[cfg(windows)]
unsafe impl Send for Tree {}
#[cfg(windows)]
unsafe impl Sync for Tree {}

#[cfg(windows)]
impl Tree {
    fn prepare(_command: &mut Command) {}

    /// Put the process in a new job object, which every process it starts
    /// joins. A process it started before this call returned is not in the
    /// job; a CLI takes far longer than that to start one.
    fn adopt(child: &Child) -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};

        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("the process ended before it could be owned"))?;
        // SAFETY: both arguments are optional and null asks for the defaults:
        // no security attributes and no name.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let tree = Self { job };
        tree.kill_on_close(true)?;
        // SAFETY: `job` was created above and `process` is the live handle of
        // a child this function borrows.
        if unsafe { AssignProcessToJobObject(tree.job, process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(tree)
    }

    /// Whether closing the job's last handle terminates what is in it.
    fn kill_on_close(&self, on: bool) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            if on { JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } else { 0 };
        let size = u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(io::Error::other)?;
        // SAFETY: `limits` is the struct this information class takes, and the
        // length passed is its size.
        let set = unsafe {
            SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size,
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Windows has no way to ask: ending a job is terminating it.
    fn ask(&self) {
        self.kill();
    }

    /// Terminate every process in the job.
    fn kill(&self) {
        // SAFETY: `job` is a job object handle this value owns.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }

    /// Leave whatever is left in the job running when its handle closes.
    fn release(&self) {
        let _ = self.kill_on_close(false);
    }
}

#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: `job` is a handle this value owns, closed here and nowhere
        // else.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

/// A platform with no way to end a process tree: the process this app spawned
/// is killed (`kill_on_drop`, `start_kill`), and nothing more.
#[cfg(not(any(unix, windows)))]
struct Tree;

#[cfg(not(any(unix, windows)))]
impl Tree {
    fn prepare(_command: &mut Command) {}

    fn adopt(_child: &Child) -> io::Result<Self> {
        Ok(Self)
    }

    fn ask(&self) {}

    fn kill(&self) {}

    fn release(&self) {}
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    use std::ffi::CString;
    use std::future::Future;
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;
    use tokio::sync::oneshot;

    /// Long enough that only a hang runs into it.
    const PATIENCE: Duration = Duration::from_secs(20);

    async fn within<T>(waited: impl Future<Output = T>) -> T {
        tokio::time::timeout(PATIENCE, waited).await.expect("this should not take 20 seconds")
    }

    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    /// A named pipe, which is how a test knows a process is alive without
    /// asking the clock: a pipe is open for as long as a process holds it.
    struct Pipe {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Pipe {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("microflow-runs-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("pipe");
            let name = CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: `name` is a NUL-terminated path that outlives the call.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            Self { dir, path }
        }

        /// `script`, started with this pipe's path in `$PIPE`.
        fn given_to(&self, script: &str) -> Command {
            let mut command = sh(script);
            command.env("PIPE", &self.path);
            command
        }

        /// Watch the processes that write to the pipe. The first receiver
        /// resolves once a process holds the pipe open, the second once no
        /// process does: every one that held it is dead.
        fn watch(&self) -> (oneshot::Receiver<()>, oneshot::Receiver<()>) {
            let (held, is_held) = oneshot::channel();
            let (released, is_released) = oneshot::channel();
            let path = self.path.clone();
            std::thread::spawn(move || {
                // Opening the read end waits for a writer.
                let mut pipe = std::fs::File::open(path).unwrap();
                let _ = held.send(());
                // Reading waits for a byte, or for the last writer to go.
                while pipe.read(&mut [0; 16]).unwrap() > 0 {}
                let _ = released.send(());
            });
            (is_held, is_released)
        }

        /// Hold the pipe's write end open for a process that reads it. The
        /// receiver resolves once the process is reading; dropping the sender
        /// closes the pipe, which the process reads as the end of its input.
        fn feed(&self) -> (oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
            let (read, is_read) = oneshot::channel();
            let (close, closed) = std::sync::mpsc::channel::<()>();
            let path = self.path.clone();
            std::thread::spawn(move || {
                // Opening the write end waits for a reader.
                let pipe = std::fs::OpenOptions::new().write(true).open(path).unwrap();
                let _ = read.send(());
                let _ = closed.recv();
                drop(pipe);
            });
            (is_read, close)
        }
    }

    impl Drop for Pipe {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A process that starts a second one and waits on it. The second holds
    /// the pipe open; the first never touches it.
    const PARENT_AND_CHILD: &str = r#"sleep 30 > "$PIPE" & wait"#;

    /// The same two processes, neither of which ends when asked to.
    const DEAF_PARENT_AND_CHILD: &str = r#"trap '' TERM; sleep 30 > "$PIPE" & wait"#;

    fn stdout(ended: Ended) -> String {
        match ended {
            Ended::Exited(output) => String::from_utf8(output.stdout).unwrap(),
            Ended::Stopped => panic!("the run was stopped"),
        }
    }

    #[tokio::test]
    async fn a_run_that_exits_by_itself_returns_what_it_wrote_and_how_it_exited() {
        let runs = AgentCliRuns::default();

        let ended = runs.run("turn", sh("cat; echo oops >&2; exit 3"), b"the prompt").await;

        let Ok(Ended::Exited(output)) = ended else { panic!("{ended:?}") };
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout), "the prompt");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "oops\n");
    }

    #[tokio::test]
    async fn stop_ends_the_process_and_the_process_it_started() {
        let runs = Arc::new(AgentCliRuns::default());
        let pipe = Pipe::new();
        let (held, released) = pipe.watch();
        let run = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(PARENT_AND_CHILD);
            async move { runs.run("turn", command, b"").await }
        });
        within(held).await.unwrap();

        runs.stop("turn");

        within(released).await.unwrap();
        assert!(matches!(within(run).await.unwrap(), Ok(Ended::Stopped)));
    }

    #[tokio::test]
    async fn a_process_that_does_not_end_when_asked_is_killed_after_the_grace() {
        let runs = Arc::new(AgentCliRuns::with_grace(Duration::from_millis(50)));
        let pipe = Pipe::new();
        let (held, released) = pipe.watch();
        let run = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(DEAF_PARENT_AND_CHILD);
            async move { runs.run("turn", command, b"").await }
        });
        within(held).await.unwrap();

        runs.stop("turn");

        within(released).await.unwrap();
        assert!(matches!(within(run).await.unwrap(), Ok(Ended::Stopped)));
    }

    #[tokio::test]
    async fn a_stop_that_comes_before_its_run_keeps_the_run_from_starting() {
        let runs = AgentCliRuns::default();
        let dir = std::env::temp_dir().join(format!("microflow-runs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let mark = dir.join("started");
        let started = || {
            let mut command = sh(r#": > "$MARK"; echo ran"#);
            command.env("MARK", &mark);
            command
        };

        runs.stop("turn");
        let ended = runs.run("turn", started(), b"").await;

        assert!(matches!(ended, Ok(Ended::Stopped)));
        assert!(!mark.exists());

        // The stop was for that run. The name is free again.
        assert_eq!(stdout(runs.run("turn", started(), b"").await.unwrap()), "ran\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_stop_for_a_run_that_is_over_does_not_end_the_run_going_now() {
        let runs = Arc::new(AgentCliRuns::default());
        assert_eq!(stdout(runs.run("first", sh("echo one"), b"").await.unwrap()), "one\n");

        let pipe = Pipe::new();
        let (reading, close) = pipe.feed();
        let second = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(r#"cat "$PIPE"; echo two"#);
            async move { runs.run("second", command, b"").await }
        });
        within(reading).await.unwrap();

        // The first turn's stop, arriving while the second turn's CLI runs.
        runs.stop("first");

        // The second run goes on to its own end.
        drop(close);
        assert_eq!(stdout(within(second).await.unwrap().unwrap()), "two\n");
    }

    #[tokio::test]
    async fn stop_all_ends_every_run() {
        let runs = Arc::new(AgentCliRuns::default());
        let pipes = [Pipe::new(), Pipe::new()];
        let mut watched = Vec::new();
        for (index, pipe) in pipes.iter().enumerate() {
            let (held, released) = pipe.watch();
            let run = tokio::spawn({
                let runs = Arc::clone(&runs);
                let command = pipe.given_to(PARENT_AND_CHILD);
                async move { runs.run(&format!("turn-{index}"), command, b"").await }
            });
            within(held).await.unwrap();
            watched.push((released, run));
        }

        runs.stop_all();

        for (released, run) in watched {
            within(released).await.unwrap();
            assert!(matches!(within(run).await.unwrap(), Ok(Ended::Stopped)));
        }
    }

    #[tokio::test]
    async fn shutdown_kills_what_does_not_end_without_the_runtime_running() {
        let runs = Arc::new(AgentCliRuns::with_grace(Duration::from_millis(50)));
        let pipe = Pipe::new();
        let (held, released) = pipe.watch();
        let run = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(DEAF_PARENT_AND_CHILD);
            async move { runs.run("turn", command, b"").await }
        });
        within(held).await.unwrap();

        // This test's runtime has one thread, and `shutdown` blocks it: the
        // future of the run cannot be what kills the process.
        runs.shutdown();

        within(released).await.unwrap();
        assert!(matches!(within(run).await.unwrap(), Ok(Ended::Stopped)));
    }

    #[tokio::test]
    async fn dropping_a_run_kills_its_process_and_frees_its_name() {
        let runs = Arc::new(AgentCliRuns::default());
        let pipe = Pipe::new();
        let (held, released) = pipe.watch();
        let run = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(DEAF_PARENT_AND_CHILD);
            async move { runs.run("turn", command, b"").await }
        });
        within(held).await.unwrap();

        run.abort();

        within(released).await.unwrap();
        assert_eq!(stdout(runs.run("turn", sh("echo again"), b"").await.unwrap()), "again\n");
    }

    #[tokio::test]
    async fn a_name_that_is_running_cannot_be_started_again() {
        let runs = Arc::new(AgentCliRuns::default());
        let pipe = Pipe::new();
        let (held, released) = pipe.watch();
        let run = tokio::spawn({
            let runs = Arc::clone(&runs);
            let command = pipe.given_to(PARENT_AND_CHILD);
            async move { runs.run("turn", command, b"").await }
        });
        within(held).await.unwrap();

        let second = runs.run("turn", sh("echo twice"), b"").await;

        let Err(Failure::Start(error)) = second else { panic!("{second:?}") };
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);

        // The refusal left the first run as it was: still there to stop.
        runs.stop("turn");
        within(released).await.unwrap();
        assert!(matches!(within(run).await.unwrap(), Ok(Ended::Stopped)));
    }
}
