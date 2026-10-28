'use strict';

// Shutdown never sends packets through a busy WSTP link. Stop new work, kill
// only the session's verified process, then asynchronously drain native work
// before freeing its link. If draining fails, retain the session and fail closed.
const path = require('path');
const {execFile} = require('child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const failure = (code,message) => Object.assign(new Error(message),{code});

async function verifyProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
        throw failure('kernel-pid-unverified','Cannot safely identify this kernel process; no process was killed.');
    try { process.kill(pid,0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    // The native/ChildProcess PID names the launched kernel. Also reject PID
    // reuse by a process belonging to another host, or a different executable.
    if (process.platform === 'win32') return;
    const out = await new Promise((resolve,reject) => execFile('ps',['-o','ppid=,comm=','-p',String(pid)],
        {timeout:1500},(error,stdout) => {
            if (!error) return resolve(stdout);
            try { process.kill(pid,0); } catch (probe) { if (probe.code==='ESRCH') return resolve(''); }
            reject(error);
        }));
    if (!out.trim()) return;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(out);
    if (!match || Number(match[1])!==process.pid || !/^(?:WolframKernel|MathKernel)(?:\.exe)?$/i.test(path.basename(match[2])))
        throw failure('kernel-pid-unverified','The recorded PID is not a Wolfram kernel owned by this host; no process was killed.');
}

async function closeSession(self,session,{verify=verifyProcess,sleep=delay,timeoutMs=10000,now=Date.now}={}) {
    const safe = typeof session.beginClose==='function' && typeof session.canClose==='boolean';
    if (!safe) {
        // Old addons cannot prove that their native reader stopped. Never run
        // their unsafe close on a busy/faulted kernel, even after an OS kill.
        if (session.isReady!==true || self._evalDispatched || self._directEvaluationCount>0 ||
            self.isAborting || self._abortPending || self._connectionLost || self._abortUncertain)
            throw failure('safe-shutdown-unavailable','This loaded WSTP addon cannot safely close a busy or faulted kernel. Install the updated addon and reload when safe; the window and other kernels were left intact.');
        if (session.close()===false) throw failure('kernel-close-incomplete','The native session has not finished closing.');
        return;
    }
    const nativePid=Number(session.kernelPid)||0,external=self._externalKernelProc;
    const pid=nativePid || external?.pid || self.kernelMetadata?.pid;
    if (pid) await verify(pid);
    else if (!session.canClose) throw failure('kernel-pid-unverified','Busy kernel has no verified PID; its link was left intact.');
    if (self.session && self.session!==session)
        throw failure('kernel-target-changed','The controller session changed during shutdown verification; no process was killed.');
    session.beginClose();
    if (pid) {
        if (nativePid && typeof session.terminate==='function') {
            if (session.terminate()!==true) throw failure('kernel-terminate-failed','Could not terminate this kernel process; its link was left intact.');
        } else if (external?.pid===pid) {
            if (external.exitCode==null && external.signalCode==null && !external.kill('SIGKILL'))
                throw failure('kernel-terminate-failed','Could not terminate this kernel process; its link was left intact.');
        } else throw failure('kernel-terminate-unavailable','This addon has no isolated process termination capability; its link was left intact.');
    }
    const deadline=now()+timeoutMs;
    while (!session.canClose) {
        if (now()>=deadline) throw failure('kernel-reader-not-drained','The kernel was terminated, but its native reader has not stopped. Its link is retained to protect this window; other kernels were left intact.');
        await sleep(20);
    }
    if (session.close()!==true) throw failure('kernel-close-incomplete','The native session did not confirm shutdown; no replacement was launched.');
}

module.exports={closeSession,verifyProcess};
