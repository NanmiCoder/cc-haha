#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "agent_desktop.h"

static const char *rc_name(int32_t rc) {
  switch (rc) {
  case AD_RESULT_OK:
    return "OK";
  case AD_RESULT_ERR_PERM_DENIED:
    return "PERM_DENIED";
  case AD_RESULT_ERR_ELEMENT_NOT_FOUND:
    return "ELEMENT_NOT_FOUND";
  case AD_RESULT_ERR_APP_NOT_FOUND:
    return "APP_NOT_FOUND";
  case AD_RESULT_ERR_ACTION_FAILED:
    return "ACTION_FAILED";
  case AD_RESULT_ERR_ACTION_NOT_SUPPORTED:
    return "ACTION_NOT_SUPPORTED";
  case AD_RESULT_ERR_STALE_REF:
    return "STALE_REF";
  case AD_RESULT_ERR_WINDOW_NOT_FOUND:
    return "WINDOW_NOT_FOUND";
  case AD_RESULT_ERR_PLATFORM_NOT_SUPPORTED:
    return "PLATFORM_NOT_SUPPORTED";
  case AD_RESULT_ERR_TIMEOUT:
    return "TIMEOUT";
  case AD_RESULT_ERR_INVALID_ARGS:
    return "INVALID_ARGS";
  case AD_RESULT_ERR_NOTIFICATION_NOT_FOUND:
    return "NOTIFICATION_NOT_FOUND";
  case AD_RESULT_ERR_INTERNAL:
    return "INTERNAL";
  case AD_RESULT_ERR_SNAPSHOT_NOT_FOUND:
    return "SNAPSHOT_NOT_FOUND";
  case AD_RESULT_ERR_POLICY_DENIED:
    return "POLICY_DENIED";
  case AD_RESULT_ERR_AMBIGUOUS_TARGET:
    return "AMBIGUOUS_TARGET";
  case AD_RESULT_ERR_APP_UNRESPONSIVE:
    return "APP_UNRESPONSIVE";
  default:
    return "UNKNOWN";
  }
}

static int envelope_ok(const char *json) {
  if (json == NULL) {
    return 0;
  }
  FILE *validator = popen("python3 -c 'import json, sys; doc = json.load(sys.stdin); "
                          "sys.exit(0 if isinstance(doc, dict) and doc.get(\"ok\") is True else 1)'", "w");
  if (validator == NULL) {
    return 0;
  }
  size_t length = strlen(json);
  size_t written = fwrite(json, 1, length, validator);
  int status = pclose(validator);
  return written == length && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static long envelope_int(const char *json, const char *key) {
  char needle[64];
  snprintf(needle, sizeof needle, "\"%s\":", key);
  const char *at = json == NULL ? NULL : strstr(json, needle);
  if (at == NULL) {
    return -1;
  }
  return strtol(at + strlen(needle), NULL, 10);
}

static void envelope_code(const char *json, char *out, size_t size) {
  out[0] = '\0';
  if (json == NULL) {
    return;
  }
  const char *at = strstr(json, "\"code\":\"");
  if (at == NULL) {
    return;
  }
  at += strlen("\"code\":\"");
  size_t index = 0;
  while (at[index] != '\0' && at[index] != '"' && index + 1 < size) {
    out[index] = at[index];
    index++;
  }
  out[index] = '\0';
}

static int has_qualified_ref(const char *json) {
  return json != NULL && strstr(json, "\"ref_id\":\"@") != NULL;
}

static void copy_str(char *dst, size_t size, const char *src) {
  if (src == NULL) {
    dst[0] = '\0';
    return;
  }
  snprintf(dst, size, "%s", src);
}

static int touch_file(const char *path) {
  FILE *file = fopen(path, "w");
  if (file == NULL) {
    return -1;
  }
  fclose(file);
  return 0;
}

static int file_exists(const char *path) { return access(path, F_OK) == 0; }

static int wait_for_file(const char *path, int seconds) {
  int tries = seconds * 20;
  for (int i = 0; i < tries; i++) {
    if (file_exists(path)) {
      return 0;
    }
    usleep(50000);
  }
  return -1;
}

static pid_t spawn_app(const char *command) {
  pid_t pid = fork();
  if (pid == 0) {
    execlp(command, command, (char *)NULL);
    _exit(127);
  }
  return pid;
}

static void stop_pid(pid_t pid) {
  int status = 0;
  if (pid <= 0) {
    return;
  }
  kill(pid, SIGTERM);
  for (int i = 0; i < 100; i++) {
    pid_t done = waitpid(pid, &status, WNOHANG);
    if (done == pid || (done == -1 && kill(pid, 0) != 0)) {
      return;
    }
    usleep(50000);
  }
  kill(pid, SIGKILL);
  waitpid(pid, &status, 0);
}

static int cmd_abi(const struct AdAdapter *adapter) {
  (void)adapter;
  uint32_t major = ad_abi_version();
  size_t action = ad_action_size();
  size_t result = ad_action_result_size();
  size_t ref_entry = ad_ref_entry_size();
  size_t window = ad_exact_window_info_size();
  if (major != AD_ABI_VERSION_MAJOR) {
    fprintf(stderr, "abi: FAIL code=ABI_VERSION rc=%u expected=%u\n", major,
            (unsigned)AD_ABI_VERSION_MAJOR);
    return 1;
  }
  if (action != AD_ACTION_SIZE || result != AD_ACTION_RESULT_SIZE ||
      ref_entry != AD_REF_ENTRY_SIZE || window != AD_EXACT_WINDOW_INFO_SIZE) {
    fprintf(stderr,
            "abi: FAIL code=LAYOUT action=%zu/%d result=%zu/%d ref_entry=%zu/%d "
            "window=%zu/%d\n",
            action, AD_ACTION_SIZE, result, AD_ACTION_RESULT_SIZE, ref_entry,
            AD_REF_ENTRY_SIZE, window, AD_EXACT_WINDOW_INFO_SIZE);
    return 1;
  }
  printf("abi: ok major=%u action=%zu result=%zu ref_entry=%zu window=%zu\n",
         major, action, result, ref_entry, window);
  return 0;
}

static int cmd_handshake(const struct AdAdapter *unused) {
  (void)unused;
  struct AdAdapter *before = ad_adapter_create();
  if (before == NULL) {
    fprintf(stderr, "handshake: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  ad_adapter_destroy(before);

  int32_t wrong = ad_init(AD_ABI_VERSION_MAJOR + 1);
  int32_t right = ad_init(AD_ABI_VERSION_MAJOR);
  if (right != AD_RESULT_OK) {
    fprintf(stderr, "handshake: FAIL code=INIT_OK rc=%d\n", right);
    return 1;
  }
  if (wrong != AD_RESULT_ERR_INVALID_ARGS) {
    fprintf(stderr, "handshake: FAIL code=INIT_MISMATCH rc=%d expected=%d\n", wrong,
            AD_RESULT_ERR_INVALID_ARGS);
    return 1;
  }

  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "handshake: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  int32_t permissions = ad_check_permissions(adapter);
  ad_adapter_destroy(adapter);
  printf("handshake: ok init=%d wrong=%d checks=%d\n", right, wrong, permissions);
  return 0;
}

static int cmd_snapshot(const struct AdAdapter *unused, const char *app) {
  (void)unused;
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "snapshot: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  char *out = NULL;
  int32_t rc = ad_snapshot(adapter, app, 0, 10, true, false, &out);
  char code[64];
  envelope_code(out, code, sizeof code);
  if (rc != AD_RESULT_OK || !envelope_ok(out)) {
    fprintf(stderr, "snapshot: FAIL code=%s rc=%d (%s)\n",
            code[0] ? code : rc_name(rc), rc, rc_name(rc));
    if (out != NULL) {
      ad_free_string(out);
    }
    ad_adapter_destroy(adapter);
    return 1;
  }
  long ref_count = envelope_int(out, "ref_count");
  int complete = strstr(out, "\"complete\":false") == NULL;
  if (ref_count <= 0 || !complete || !has_qualified_ref(out)) {
    fprintf(stderr, "snapshot: FAIL code=INCOMPLETE ref_count=%ld complete=%d ref=%d\n",
            ref_count, complete, has_qualified_ref(out));
    ad_free_string(out);
    ad_adapter_destroy(adapter);
    return 1;
  }
  fputs(out, stdout);
  fprintf(stderr, "snapshot: ok rc=0 ref_count=%ld complete=1\n", ref_count);
  ad_free_string(out);
  ad_adapter_destroy(adapter);
  return 0;
}

static int cmd_click(const struct AdAdapter *unused, const char *ref) {
  (void)unused;
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "click: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  struct AdAction action;
  memset(&action, 0, sizeof action);
  action.kind = AD_ACTION_KIND_CLICK;
  char *out = NULL;
  int32_t rc = ad_execute_by_ref_timeout(adapter, ref, &action, 0, 5000, &out);
  char code[64];
  envelope_code(out, code, sizeof code);
  if (rc == AD_RESULT_ERR_PLATFORM_NOT_SUPPORTED ||
      strcmp(code, "PLATFORM_NOT_SUPPORTED") == 0) {
    fprintf(stderr, "click: FAIL code=PLATFORM_NOT_SUPPORTED rc=%d (%s)\n", rc,
            rc_name(rc));
    if (out != NULL) {
      ad_free_string(out);
    }
    ad_adapter_destroy(adapter);
    return 1;
  }
  if (rc != AD_RESULT_OK || !envelope_ok(out)) {
    fprintf(stderr, "click: FAIL code=%s rc=%d (%s)\n", code[0] ? code : rc_name(rc),
            rc, rc_name(rc));
    if (out != NULL) {
      ad_free_string(out);
    }
    ad_adapter_destroy(adapter);
    return 1;
  }
  fputs(out, stdout);
  fprintf(stderr, "click: ok rc=0\n");
  ad_free_string(out);
  ad_adapter_destroy(adapter);
  return 0;
}

static int copy_window(const struct AdExactWindowInfo *source, char *id, size_t id_size,
                       char *instance, size_t instance_size, char *title,
                       size_t title_size, char *app_name, size_t app_size,
                       struct AdExactWindowInfo *copy) {
  copy_str(id, id_size, source->window.id);
  copy_str(instance, instance_size, source->process_instance);
  copy_str(title, title_size, source->window.title);
  copy_str(app_name, app_size, source->window.app_name);
  memset(copy, 0, sizeof *copy);
  copy->version = AD_EXACT_WINDOW_INFO_VERSION;
  copy->size = AD_EXACT_WINDOW_INFO_SIZE;
  copy->window.id = id;
  copy->window.title = title;
  copy->window.app_name = app_name;
  copy->window.pid = source->window.pid;
  copy->process_instance = instance;
  copy->accessible = source->accessible;
  return 0;
}

static int wait_for_owned_window(struct AdAdapter *adapter, const char *app, pid_t pid,
                                 char *id, size_t id_size, char *instance,
                                 size_t instance_size, char *title, size_t title_size,
                                 char *app_name, size_t app_size,
                                 struct AdExactWindowInfo *copy) {
  for (int attempt = 0; attempt < 300; attempt++) {
    struct AdExactWindowList *list = NULL;
    int32_t rc = ad_list_windows_exact(adapter, app, false, &list);
    if (rc == AD_RESULT_OK && list != NULL) {
      uint32_t count = ad_exact_window_list_count(list);
      for (uint32_t i = 0; i < count; i++) {
        const struct AdExactWindowInfo *item = ad_exact_window_list_get(list, i);
        if (item != NULL && item->window.pid == (uint32_t)pid) {
          copy_window(item, id, id_size, instance, instance_size, title, title_size,
                      app_name, app_size, copy);
          ad_exact_window_list_free(list);
          return 0;
        }
      }
      ad_exact_window_list_free(list);
    }
    usleep(100000);
  }
  return -1;
}

static int read_tree(struct AdAdapter *adapter, const struct AdExactWindowInfo *window,
                     uint32_t *nodes) {
  struct AdTreeOptions options;
  memset(&options, 0, sizeof options);
  options.max_depth = 10;
  options.include_bounds = true;
  options.interactive_only = false;
  options.compact = false;
  options.surface = 0;
  struct AdNodeTree tree;
  memset(&tree, 0, sizeof tree);
  int32_t rc = ad_get_tree_exact(adapter, window, &options, &tree);
  if (rc == AD_RESULT_OK) {
    *nodes = tree.count;
    ad_free_tree(&tree);
  }
  return rc;
}

static int cmd_windows_exact(const struct AdAdapter *unused, const char *app) {
  (void)unused;
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "windows-exact: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  char id[512], instance[128], title[512], app_name[256];
  struct AdExactWindowInfo first;
  pid_t first_pid = spawn_app(app);
  if (first_pid < 0 ||
      wait_for_owned_window(adapter, app, first_pid, id, sizeof id, instance,
                            sizeof instance, title, sizeof title, app_name,
                            sizeof app_name, &first) != 0) {
    fprintf(stderr, "windows-exact: FAIL code=WINDOW_NOT_FOUND target=first\n");
    stop_pid(first_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  uint32_t nodes = 0;
  int32_t rc = read_tree(adapter, &first, &nodes);
  if (rc != AD_RESULT_OK || nodes == 0) {
    fprintf(stderr, "windows-exact: FAIL code=%s rc=%d nodes=%u\n", rc_name(rc), rc,
            nodes);
    stop_pid(first_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  printf("windows-exact: first id=%s instance=%s nodes=%u\n", id, instance, nodes);

  stop_pid(first_pid);
  nodes = 0;
  rc = read_tree(adapter, &first, &nodes);
  if (rc != AD_RESULT_ERR_WINDOW_NOT_FOUND) {
    fprintf(stderr, "windows-exact: FAIL code=%s rc=%d expected=WINDOW_NOT_FOUND\n",
            rc_name(rc), rc);
    ad_adapter_destroy(adapter);
    return 1;
  }

  pid_t second_pid = spawn_app(app);
  char second_id[512], second_instance[128], second_title[512], second_app[256];
  struct AdExactWindowInfo second;
  if (second_pid < 0 ||
      wait_for_owned_window(adapter, app, second_pid, second_id, sizeof second_id,
                            second_instance, sizeof second_instance, second_title,
                            sizeof second_title, second_app, sizeof second_app,
                            &second) != 0) {
    fprintf(stderr, "windows-exact: FAIL code=WINDOW_NOT_FOUND target=second\n");
    stop_pid(second_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  if (strcmp(id, second_id) == 0 || strcmp(instance, second_instance) == 0) {
    fprintf(stderr, "windows-exact: FAIL code=STALE_ID_BOUND id_same=%d instance_same=%d\n",
            strcmp(id, second_id) == 0, strcmp(instance, second_instance) == 0);
    stop_pid(second_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  nodes = 0;
  rc = read_tree(adapter, &second, &nodes);
  if (rc != AD_RESULT_OK || nodes == 0) {
    fprintf(stderr, "windows-exact: FAIL code=%s rc=%d nodes=%u target=fresh\n",
            rc_name(rc), rc, nodes);
    stop_pid(second_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  nodes = 0;
  rc = read_tree(adapter, &first, &nodes);
  if (rc != AD_RESULT_ERR_WINDOW_NOT_FOUND) {
    fprintf(stderr, "windows-exact: FAIL code=%s rc=%d expected=WINDOW_NOT_FOUND\n",
            rc_name(rc), rc);
    stop_pid(second_pid);
    ad_adapter_destroy(adapter);
    return 1;
  }
  stop_pid(second_pid);
  for (int attempt = 0; attempt < 100; attempt++) {
    struct AdExactWindowList *list = NULL;
    int32_t listed = ad_list_windows_exact(adapter, app, false, &list);
    uint32_t count = listed == AD_RESULT_OK && list != NULL
                         ? ad_exact_window_list_count(list)
                         : 0;
    if (list != NULL) {
      ad_exact_window_list_free(list);
    }
    if (listed == AD_RESULT_OK && count == 0) {
      break;
    }
    usleep(100000);
  }
  ad_adapter_destroy(adapter);
  printf("windows-exact: ok old=WINDOW_NOT_FOUND fresh=ok distinct=1\n");
  return 0;
}

static int snapshot_rc(struct AdAdapter *adapter, const char *app, char **out) {
  return ad_snapshot(adapter, app, 0, 8, true, false, out);
}

struct worker {
  struct AdAdapter *adapter;
  const char *app;
  int ok_count;
  int32_t last_rc;
};

static void *worker_loop(void *arg) {
  struct worker *state = arg;
  state->ok_count = 0;
  state->last_rc = 0;
  for (int i = 0; i < 3; i++) {
    char *out = NULL;
    int32_t rc = snapshot_rc(state->adapter, state->app, &out);
    if (rc == AD_RESULT_OK && envelope_ok(out)) {
      state->ok_count++;
    } else {
      state->last_rc = rc;
    }
    if (out != NULL) {
      ad_free_string(out);
    }
  }
  return NULL;
}

static int cmd_lifetime(const struct AdAdapter *unused, const char *app) {
  (void)unused;
  for (int cycle = 0; cycle < 20; cycle++) {
    struct AdAdapter *adapter = ad_adapter_create();
    if (adapter == NULL) {
      fprintf(stderr, "lifetime: FAIL code=ADAPTER_CREATE cycle=%d\n", cycle);
      return 1;
    }
    char *out = NULL;
    int32_t rc = snapshot_rc(adapter, app, &out);
    int ok = rc == AD_RESULT_OK && envelope_ok(out);
    if (out != NULL) {
      ad_free_string(out);
    }
    ad_adapter_destroy(adapter);
    if (!ok) {
      fprintf(stderr, "lifetime: FAIL code=%s rc=%d cycle=%d\n",
              rc == AD_RESULT_OK ? "SNAPSHOT_ENVELOPE" : rc_name(rc), rc, cycle);
      return 1;
    }
  }

  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "lifetime: FAIL code=ADAPTER_CREATE\n");
    return 1;
  }
  ad_adapter_destroy(adapter);

  char *out = NULL;
  int32_t after = snapshot_rc(adapter, app, &out);
  if (out != NULL) {
    ad_free_string(out);
  }
  if (after != AD_RESULT_ERR_INVALID_ARGS) {
    fprintf(stderr, "lifetime: FAIL code=%s rc=%d expected=INVALID_ARGS\n",
            rc_name(after), after);
    return 1;
  }
  printf("lifetime: ok cycles=20 after_destroy=%d\n", after);
  return 0;
}

static int cmd_serialise(const struct AdAdapter *unused, const char *app) {
  (void)unused;
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "serialise: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  pthread_t threads[8];
  struct worker states[8];
  for (int i = 0; i < 8; i++) {
    states[i].adapter = adapter;
    states[i].app = app;
    pthread_create(&threads[i], NULL, worker_loop, &states[i]);
  }
  int ok_count = 0;
  int32_t failure = 0;
  for (int i = 0; i < 8; i++) {
    pthread_join(threads[i], NULL);
    ok_count += states[i].ok_count;
    if (states[i].last_rc != 0) {
      failure = states[i].last_rc;
    }
  }
  ad_adapter_destroy(adapter);
  if (ok_count != 24) {
    fprintf(stderr, "serialise: FAIL code=%s rc=%d calls=%d/24\n", rc_name(failure),
            failure, ok_count);
    return 1;
  }
  printf("serialise: ok calls=%d/24\n", ok_count);
  return 0;
}

static int cmd_bus(const struct AdAdapter *unused, const char *app, const char *dir) {
  (void)unused;
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "bus: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  char *out = NULL;
  int32_t rc = snapshot_rc(adapter, app, &out);
  int baseline = rc == AD_RESULT_OK && envelope_ok(out);
  if (out != NULL) {
    ad_free_string(out);
  }
  if (!baseline) {
    fprintf(stderr, "bus: FAIL code=%s rc=%d target=baseline\n", rc_name(rc), rc);
    ad_adapter_destroy(adapter);
    return 1;
  }

  char marker[1024];
  snprintf(marker, sizeof marker, "%s/kill-request", dir);
  if (touch_file(marker) != 0) {
    fprintf(stderr, "bus: FAIL code=MARKER rc=%d\n", errno);
    ad_adapter_destroy(adapter);
    return 1;
  }
  snprintf(marker, sizeof marker, "%s/killed", dir);
  if (wait_for_file(marker, 30) != 0) {
    fprintf(stderr, "bus: FAIL code=BUS_KILL rc=timeout\n");
    ad_adapter_destroy(adapter);
    return 1;
  }

  for (int i = 0; i < 3; i++) {
    out = NULL;
    rc = snapshot_rc(adapter, app, &out);
    if (out != NULL) {
      ad_free_string(out);
    }
    if (rc != AD_RESULT_ERR_INTERNAL) {
      fprintf(stderr, "bus: FAIL code=%s rc=%d expected=INTERNAL sample=%d\n",
              rc_name(rc), rc, i);
      ad_adapter_destroy(adapter);
      return 1;
    }
  }

  int32_t lost_permissions = ad_check_permissions(adapter);
  if (lost_permissions != AD_RESULT_ERR_INTERNAL) {
    fprintf(stderr, "bus: FAIL code=%s rc=%d expected=INTERNAL phase=permissions\n",
            rc_name(lost_permissions), lost_permissions);
    ad_adapter_destroy(adapter);
    return 1;
  }

  snprintf(marker, sizeof marker, "%s/relaunch-request", dir);
  if (touch_file(marker) != 0) {
    fprintf(stderr, "bus: FAIL code=MARKER rc=%d\n", errno);
    ad_adapter_destroy(adapter);
    return 1;
  }  snprintf(marker, sizeof marker, "%s/relaunched", dir);
  if (wait_for_file(marker, 30) != 0) {
    fprintf(stderr, "bus: FAIL code=RELAUNCH rc=timeout\n");
    ad_adapter_destroy(adapter);
    return 1;
  }

  int recovered = 0;
  char *last = NULL;
  for (int i = 0; i < 400; i++) {
    out = NULL;
    rc = snapshot_rc(adapter, app, &out);
    recovered = rc == AD_RESULT_OK && envelope_ok(out);
    if (recovered) {
      if (out != NULL) {
        ad_free_string(out);
      }
      break;
    }
    if (last != NULL) {
      ad_free_string(last);
    }
    last = out;
    usleep(100000);
  }
  ad_adapter_destroy(adapter);
  if (!recovered) {
    fprintf(stderr, "bus: FAIL code=%s rc=%d target=recovery detail=%s\n", rc_name(rc), rc,
            last != NULL ? last : "null");
    if (last != NULL) {
      ad_free_string(last);
    }
    return 1;
  }
  if (last != NULL) {
    ad_free_string(last);
  }
  printf("bus: ok baseline=ok lost=%s recovered=ok\n", "INTERNAL");
  return 0;
}

static int cmd_clipboard_set(const char *text) {
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "clipboard-set: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  int32_t rc = ad_set_clipboard(adapter, text);
  ad_adapter_destroy(adapter);
  if (rc != AD_RESULT_OK) {
    fprintf(stderr, "clipboard-set: FAIL code=%s rc=%d\n", rc_name(rc), rc);
    return 1;
  }
  printf("clipboard-set: ok\n");
  return 0;
}

static int cmd_clipboard_clear(void) {
  struct AdAdapter *adapter = ad_adapter_create();
  if (adapter == NULL) {
    fprintf(stderr, "clipboard-clear: FAIL code=ADAPTER_CREATE rc=null\n");
    return 1;
  }
  int32_t rc = ad_clear_clipboard(adapter);
  ad_adapter_destroy(adapter);
  if (rc != AD_RESULT_OK) {
    fprintf(stderr, "clipboard-clear: FAIL code=%s rc=%d\n", rc_name(rc), rc);
    return 1;
  }
  printf("clipboard-clear: ok\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: consumer <abi|handshake|snapshot|click|windows-exact|"
                    "lifetime|serialise|bus|clipboard-set|clipboard-clear> [args]\n");
    return 2;
  }
  const char *command = argv[1];
  if (strcmp(command, "abi") == 0) {
    return cmd_abi(NULL);
  }
  if (strcmp(command, "handshake") == 0) {
    return cmd_handshake(NULL);
  }
  if (strcmp(command, "snapshot") == 0 && argc == 3) {
    return cmd_snapshot(NULL, argv[2]);
  }
  if (strcmp(command, "click") == 0 && argc == 3) {
    return cmd_click(NULL, argv[2]);
  }
  if (strcmp(command, "windows-exact") == 0 && argc == 3) {
    return cmd_windows_exact(NULL, argv[2]);
  }
  if (strcmp(command, "lifetime") == 0 && argc == 3) {
    return cmd_lifetime(NULL, argv[2]);
  }
  if (strcmp(command, "serialise") == 0 && argc == 3) {
    return cmd_serialise(NULL, argv[2]);
  }
  if (strcmp(command, "bus") == 0 && argc == 4) {
    return cmd_bus(NULL, argv[2], argv[3]);
  }
  if (strcmp(command, "clipboard-set") == 0 && argc == 3) {
    return cmd_clipboard_set(argv[2]);
  }
  if (strcmp(command, "clipboard-clear") == 0 && argc == 2) {
    return cmd_clipboard_clear();
  }
  fprintf(stderr, "consumer: unknown command %s\n", command);
  return 2;
}
