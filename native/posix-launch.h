#include <fcntl.h>
#include <sys/wait.h>

static int supervised_launch(char **argv) {
    const char *record = argv[3];
    int gate[2];
    if (pipe(gate)) return 4;
    pid_t child = fork();
    if (child < 0) return 4;
    if (child == 0) {
        close(gate[1]);
        if (setsid() < 0) _exit(4);
        if (strcmp(argv[2], "-") != 0) {
            int fd = open(argv[2], O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
            if (fd < 0 || write(fd, "0", 1) != 1) _exit(4);
            close(fd);
        }
        printf("%d\n", (int)getpid());
        fflush(stdout);
        char token;
        if (read(gate[0], &token, 1) != 1 || token != 'G') _exit(4);
        close(gate[0]);
        int null = open("/dev/null", O_RDWR);
        if (null < 0) _exit(4);
        for (int i = 0; i < 3; i++) if (dup2(null, i) < 0) _exit(4);
        if (null > 2) close(null);
        execvp(argv[4], argv + 4);
        _exit(126);
    }
    close(gate[0]);
    close(STDOUT_FILENO);
    int requested = getchar();
    if (requested == 'G') {
        signal(SIGPIPE, SIG_IGN);
        if (write(gate[1], "G", 1) != 1) requested = EOF;
    }
    close(gate[1]);
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 4;
    int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    if (requested == 'G') {
        char staged[4096];
        if (snprintf(staged, sizeof(staged), "%s.tmp", record) >= (int)sizeof(staged)) return 4;
        int fd = open(staged, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
        if (fd >= 0) {
            if (dprintf(fd, "%d\n", code) > 0 && fsync(fd) == 0) rename(staged, record);
            close(fd);
        }
    }
    return code;
}
