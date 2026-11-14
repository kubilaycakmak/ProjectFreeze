#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include "posix-launch.h"

static int control(const char *verb, int pid, const char *birth) {
    int signal_number = 0;
    if (!strcmp(verb, "freeze")) signal_number = SIGSTOP;
    else if (!strcmp(verb, "resume")) signal_number = SIGCONT;
    else if (!strcmp(verb, "stop")) signal_number = SIGTERM;
    else if (!strcmp(verb, "force")) signal_number = SIGKILL;
    else return 2;
    int fd = syscall(SYS_pidfd_open, pid, 0);
    if (fd < 0) return errno == ESRCH ? 3 : errno == ENOSYS ? 5 : 4;

    char path[64], line[8192];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    struct stat info;
    if (stat(path, &info) || info.st_uid != geteuid()) { close(fd); return 4; }
    FILE *file = fopen(path, "r");
    if (!file) { close(fd); return 3; }
    size_t length = fread(line, 1, sizeof(line) - 1, file);
    fclose(file);
    line[length] = '\0';
    char *end = strrchr(line, ')');
    if (!end || end[1] != ' ') { close(fd); return 3; }
    char *save = NULL;
    char *field = strtok_r(end + 2, " ", &save);
    char state = field ? field[0] : '\0';
    for (int i = 3; i < 22 && field; i++) field = strtok_r(NULL, " ", &save);
    if (!field || strcmp(field, birth) || state == 'Z' || state == 'X') { close(fd); return 3; }
    if (state == 't') { close(fd); return 4; }
    if ((state == 'T' && signal_number == SIGSTOP) || (state != 'T' && signal_number == SIGCONT)) {
        close(fd);
        return 10;
    }
    int result = syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0);
    int failure = errno;
    close(fd);
    return result == 0 ? 0 : failure == ESRCH ? 3 : failure == ENOSYS ? 5 : 4;
}

int main(int argc, char **argv) {
    if (argc >= 5 && !strcmp(argv[1], "launch")) return supervised_launch(argv);
    if (argc != 4) return 2;
    char *end;
    long pid = strtol(argv[2], &end, 10);
    if (*end || pid < 2 || pid > INT_MAX || pid == getpid() || pid == getppid()) return 2;
    return control(argv[1], (int)pid, argv[3]);
}
