#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

static void identity(const struct proc_bsdinfo *info, char *out, size_t capacity) {
    snprintf(out, capacity, "%llu.%llu", (unsigned long long)info->pbi_start_tvsec,
             (unsigned long long)info->pbi_start_tvusec);
}

static void escaped(const char *value) {
    for (const unsigned char *c = (const unsigned char *)value; *c; c++) printf("%02x", *c);
}

static int scan(void) {
    int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
    if (bytes <= 0) return 4;
    pid_t *pids = calloc(1, bytes + 4096);
    if (!pids) return 4;
    bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, bytes + 4096);
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
        pid_t pid = pids[i];
        struct proc_taskallinfo data;
        if (pid < 2 || proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, &data, sizeof(data)) != sizeof(data)) continue;
        if (data.pbsd.pbi_uid != getuid() || data.pbsd.pbi_status == SZOMB) continue;
        char birth[64], image[PROC_PIDPATHINFO_MAXSIZE] = {0};
        struct proc_vnodepathinfo cwd;
        identity(&data.pbsd, birth, sizeof(birth));
        proc_pidpath(pid, image, sizeof(image));
        printf("%d\t%u\t%u\t%d\t%s\t%s\t%llu\t%llu\t", pid, data.pbsd.pbi_ppid,
               data.pbsd.pbi_pgid, getsid(pid), birth, data.pbsd.pbi_status == SSTOP ? "T" : "R",
               (unsigned long long)(data.ptinfo.pti_total_user + data.ptinfo.pti_total_system),
               (unsigned long long)data.ptinfo.pti_resident_size);
        escaped(image);
        putchar('\t');
        if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &cwd, sizeof(cwd)) == sizeof(cwd)) escaped(cwd.pvi_cdir.vip_path);
        putchar('\n');
    }
    free(pids);
    return 0;
}

static int control(const char *verb, pid_t pid, const char *birth) {
    int sig = 0;
    if (!strcmp(verb, "freeze")) sig = SIGSTOP;
    else if (!strcmp(verb, "resume")) sig = SIGCONT;
    else if (!strcmp(verb, "stop")) sig = SIGTERM;
    else if (!strcmp(verb, "force")) sig = SIGKILL;
    else return 2;
    int (*send_checked)(audit_token_t *, int) = dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
    if (!send_checked) return 5;
    struct proc_bsdinfo data;
    char actual[64];
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &data, sizeof(data)) != sizeof(data)) return 3;
    identity(&data, actual, sizeof(actual));
    if (strcmp(actual, birth) || data.pbi_status == SZOMB) return 3;
    if (data.pbi_uid != getuid()) return 4;

    mach_port_t task;
    if (task_name_for_pid(mach_task_self(), pid, &task) != KERN_SUCCESS) return 4;
    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    kern_return_t result = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
    mach_port_deallocate(mach_task_self(), task);
    if (result != KERN_SUCCESS) return 4;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &data, sizeof(data)) != sizeof(data)) return 3;
    identity(&data, actual, sizeof(actual));
    if (strcmp(actual, birth) || data.pbi_status == SZOMB) return 3;
    if ((sig == SIGSTOP && data.pbi_status == SSTOP) || (sig == SIGCONT && data.pbi_status != SSTOP)) return 10;
    int error = send_checked(&token, sig);
    return error == 0 ? 0 : error == ESRCH ? 3 : error == ENOSYS ? 5 : 4;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "scan")) return scan();
    if (argc >= 4 && !strcmp(argv[1], "launch")) {
        puts("ready");
        fflush(stdout);
        if (getchar() != 'G') return 4;
        int null = open("/dev/null", O_RDWR);
        if (null < 0) return 4;
        for (int i = 0; i < 3; i++) if (dup2(null, i) < 0) return 4;
        if (null > 2) close(null);
        execvp(argv[3], argv + 3);
        return 126;
    }
    if (argc != 4) return 2;
    char *end;
    long pid = strtol(argv[2], &end, 10);
    if (*end || pid < 2 || pid > 2147483647L || pid == getpid() || pid == getppid()) return 2;
    return control(argv[1], (pid_t)pid, argv[3]);
}
