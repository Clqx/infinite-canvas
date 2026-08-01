#!/bin/sh
set -eu

export LC_ALL=C

AUTH_DIR=/etc/nginx/infinite-canvas
AUTH_CONFIG_FILE="$AUTH_DIR/auth.conf"
AUTH_PASSWORD_MIN_BYTES=12
AUTH_PASSWORD_MAX_BYTES=72

fail() {
    printf 'Infinite Canvas startup error: %s\n' "$1" >&2
    exit 1
}

write_auth_config() {
    auth_directive=$1
    auth_file=$2
    auth_config_tmp="$AUTH_CONFIG_FILE.tmp"

    umask 077
    {
        printf 'auth_basic %s;\n' "$auth_directive"
        if [ -n "$auth_file" ]; then
            printf 'auth_basic_user_file %s;\n' "$auth_file"
        fi
    } > "$auth_config_tmp"
    chmod 644 "$auth_config_tmp"
    mv -f "$auth_config_tmp" "$AUTH_CONFIG_FILE"
}

configure_auth() {
    auth_mode=${AUTH_MODE:-required}
    mkdir -p "$AUTH_DIR"
    chown root:nginx "$AUTH_DIR"
    chmod 750 "$AUTH_DIR"

    case "$auth_mode" in
        required)
            ;;
        disabled)
            [ "${AUTH_ALLOW_INSECURE_LOOPBACK:-}" = "1" ] || fail "AUTH_MODE=disabled requires AUTH_ALLOW_INSECURE_LOOPBACK=1 and a host loopback-only port binding"
            rm -f "$AUTH_DIR/.htpasswd"
            write_auth_config "off" ""
            printf '%s\n' 'Infinite Canvas authentication is disabled for loopback-only local use.'
            return
            ;;
        *)
            fail "AUTH_MODE must be required or disabled"
            ;;
    esac

    auth_username=${AUTH_USERNAME:-}
    [ -n "$auth_username" ] || fail "AUTH_USERNAME is required"
    printf '%s' "$auth_username" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || fail "AUTH_USERNAME must be 1-64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit"

    password_from_env=${AUTH_PASSWORD:-}
    password_file=${AUTH_PASSWORD_FILE:-}
    if [ -n "$password_from_env" ] && [ -n "$password_file" ]; then
        fail "set exactly one of AUTH_PASSWORD or AUTH_PASSWORD_FILE"
    fi
    if [ -n "$password_file" ]; then
        if [ ! -f "$password_file" ] || [ ! -r "$password_file" ]; then
            fail "AUTH_PASSWORD_FILE must reference a readable file"
        fi
        if ! auth_password=$(cat "$password_file"); then
            fail "AUTH_PASSWORD_FILE could not be read"
        fi
    else
        auth_password=$password_from_env
    fi
    [ -n "$auth_password" ] || fail "AUTH_PASSWORD or AUTH_PASSWORD_FILE is required"

    carriage_return=$(printf '\r')
    case "$auth_password" in
        *"$carriage_return"* | *"
"*) fail "authentication password must contain exactly one line" ;;
    esac
    password_bytes=$(printf '%s' "$auth_password" | wc -c | tr -d ' ')
    [ "$password_bytes" -ge "$AUTH_PASSWORD_MIN_BYTES" ] || fail "authentication password must be at least $AUTH_PASSWORD_MIN_BYTES bytes"
    [ "$password_bytes" -le "$AUTH_PASSWORD_MAX_BYTES" ] || fail "authentication password must be at most $AUTH_PASSWORD_MAX_BYTES bytes because bcrypt ignores additional bytes"

    htpasswd_tmp="$AUTH_DIR/.htpasswd.tmp"
    umask 077
    if ! printf '%s\n' "$auth_password" | htpasswd -niBC 12 "$auth_username" > "$htpasswd_tmp"; then
        rm -f "$htpasswd_tmp"
        fail "failed to create the authentication credential file"
    fi
    chown root:nginx "$htpasswd_tmp"
    chmod 640 "$htpasswd_tmp"
    mv -f "$htpasswd_tmp" "$AUTH_DIR/.htpasswd"
    write_auth_config '"Infinite Canvas"' "$AUTH_DIR/.htpasswd"

    # Do not pass cleartext credentials to nginx or its worker processes.
    auth_password=
    password_from_env=
    unset AUTH_PASSWORD
}

# 在 nginx 官方入口启动前生成鉴权文件与运行期配置，然后移除明文密码环境变量。
# 每家统计一个独立变量，未设置的留空，
# 前端据此判定该家「关闭」，不加载对应脚本、不发外部请求。可同时启用多家。

# GA4 / 百度 ID 只含字母、数字和连字符；过滤掉其它字符，
# 避免值里的引号等破坏 config.js 的 JS 字符串（纵深防御）。
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

configure_auth

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}"
};
EOF

exec /docker-entrypoint.sh "$@"
