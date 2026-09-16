#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

// This tiny signed parent supplies the required host ancestry without starting
// Electron, loading user configuration, or invoking any model.
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  pid_t child;
  int status = posix_spawn(&child, argv[1], NULL, NULL, &argv[1], environ);
  if (status != 0) return status;
  if (waitpid(child, &status, 0) < 0) return 3;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
