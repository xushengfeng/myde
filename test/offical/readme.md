# 使用 Wayland 官方的测试

```sh
git clone https://gitlab.freedesktop.org/wayland/wayland
```

我使用的提交是： d81525a235e48cc5de3e4005a16ddb1fbdfd9d7c

修改文件以测试运行的合成器：

`src/wayland-client.c`

```diff
diff --git a/src/wayland-client.c b/src/wayland-client.c
index ed686b5..be00234 100644
--- a/src/wayland-client.c
+++ b/src/wayland-client.c
@@ -1161,7 +1161,7 @@ connect_to_socket(const char *name)

 	path_is_absolute = name[0] == '/';

-	runtime_dir = getenv("XDG_RUNTIME_DIR");
+	runtime_dir = "/run/user/1000";
 	if (((!runtime_dir || runtime_dir[0] != '/') && !path_is_absolute)) {
 		wl_log("error: XDG_RUNTIME_DIR is invalid or not set in the environment.\n");
 		/* to prevent programs reporting
@@ -1170,6 +1170,9 @@ connect_to_socket(const char *name)
 		return -1;
 	}

+	printf("runtimedir: %s\n", runtime_dir ? runtime_dir : "(null)");
+	printf("name: %s\n", name ? name : "(null)");
+
 	fd = wl_os_socket_cloexec(PF_LOCAL, SOCK_STREAM, 0);
 	if (fd < 0)
 		return -1;
@@ -1348,7 +1351,7 @@ wl_display_connect(const char *name)
 	char *connection, *end;
 	int flags, fd;

-	connection = getenv("WAYLAND_SOCKET");
+	connection = NULL;
 	if (connection) {
 		int prev_errno = errno;
 		errno = 0;
```

`tests/test-runner.c`

```diff
diff --git a/tests/test-runner.c b/tests/test-runner.c
index 9a50d1d..00a3d20 100644
--- a/tests/test-runner.c
+++ b/tests/test-runner.c
@@ -203,8 +203,8 @@ rmdir_xdg_runtime_dir(void)
 	assert(xrd_env && xrd_env[0] == '/' && "No XDG_RUNTIME_DIR set");

 	/* rmdir may fail if some test didn't do clean up */
-	if (rmdir(xrd_env) == -1)
-		perror("Cleaning XDG_RUNTIME_DIR");
+	// if (rmdir(xrd_env) == -1)
+	// 	perror("Cleaning XDG_RUNTIME_DIR");
 }

 #define RED	"\033[31m"

```

编译（在 wayland 目录运行）

```sh
meson build
```

```sh
ninja -C build/
```
