#!/usr/bin/env bash
# Notification lifecycle against the real Notification Center.
# Posts real notifications via osascript, then asserts every effect by independent
# re-observation (list-notifications), never by trusting a command's own ok:true.
# Encodes the intended contracts:
#   NT1  a posted notification is observable via list-notifications --text
#   NT2  the listed `title` field carries the posted title (identity contract for
#        --expected-title / --app filtering)
#   NT3  dismiss-notification removes the row, verified by re-list
#   NT4  dismiss-all-notifications (scoped by app) clears remaining rows, verified by re-list

note "Notifications: real Notification Center lifecycle"

nc_prefix="AgentDesktopE2E-$$"
nc_title_a="$nc_prefix-alpha"
nc_title_b="$nc_prefix-beta"
nc_body="agent-desktop e2e probe"
nc_posted=""

if osascript -e "display notification \"$nc_body\" with title \"$nc_title_a\"" >/dev/null 2>&1; then
    nc_posted=1
else
    badmsg "could not post fixture notifications via osascript (Automation permission?)"
fi

if [ -n "$nc_posted" ]; then
    nc_list=""
    nc_found=""
    for _ in $(seq 1 20); do
        nc_list="$("$bin" --headed list-notifications --text "$nc_title_a" 2>/dev/null)"
        if [ "$(json_field "$nc_list" data.count)" = "1" ]; then
            nc_found=1
            break
        fi
        sleep 0.5
    done
    assert "NT1 posted notification is observable via list-notifications" \
        "$([ -n "$nc_found" ] && echo 1 || echo 0)" \
        "title='$nc_title_a' (if missing: System Settings > Notifications > Script Editor)"

    if [ -n "$nc_found" ]; then
        nc_listed_title="$(json_field "$nc_list" data.notifications.0.title)"
        nc_listed_app="$(json_field "$nc_list" data.notifications.0.app_name)"
        nc_index="$(json_field "$nc_list" data.notifications.0.index)"
        assert "NT2 listed title field carries the posted title (identity contract)" \
            "$([ "$nc_listed_title" = "$nc_title_a" ] && echo 1 || echo 0)" \
            "expected title='$nc_title_a' got title='$nc_listed_title' app_name='$nc_listed_app'"

        nc_dismiss="$("$bin" --headed dismiss-notification "$nc_index" --expected-title "$nc_listed_title" 2>/dev/null)"
        nc_dismiss_ok="$(json_field "$nc_dismiss" ok)"
        nc_gone=""
        nc_after=""
        for _ in $(seq 1 12); do
            nc_after="$("$bin" --headed list-notifications --text "$nc_title_a" 2>/dev/null)"
            if [ "$(json_field "$nc_after" data.count)" = "0" ]; then
                nc_gone=1
                break
            fi
            sleep 0.5
        done
        assert "NT3 dismiss-notification removes the row (verified by re-list, not ok:true)" \
            "$([ -n "$nc_gone" ] && [ "$nc_dismiss_ok" = "True" ] && echo 1 || echo 0)" \
            "ok=$nc_dismiss_ok error=$(json_field "$nc_dismiss" error.code) msg=$(json_field "$nc_dismiss" error.message) detail=$(json_field "$nc_dismiss" error.platform_detail) still_listed=$([ -z "$nc_gone" ] && echo yes || echo no)"

        osascript -e "display notification \"$nc_body\" with title \"$nc_title_b\"" >/dev/null 2>&1
        nc_list_b=""
        for _ in $(seq 1 10); do
            nc_list_b="$("$bin" --headed list-notifications --text "$nc_title_b" 2>/dev/null)"
            if [ "$(json_field "$nc_list_b" data.count)" = "1" ]; then
                break
            fi
            sleep 0.5
        done
        nc_app_b="$(json_field "$nc_list_b" data.notifications.0.app_name)"
        if [ -n "$nc_app_b" ]; then
            nc_sweep="$("$bin" --headed dismiss-all-notifications --app "$nc_app_b" 2>/dev/null)"
            nc_cleared=""
            nc_left=""
            for _ in $(seq 1 12); do
                nc_left="$("$bin" --headed list-notifications --text "$nc_prefix" 2>/dev/null)"
                if [ "$(json_field "$nc_left" data.count)" = "0" ]; then
                    nc_cleared=1
                    break
                fi
                sleep 0.5
            done
            assert "NT4 dismiss-all-notifications clears scoped rows (verified by re-list)" \
                "$([ -n "$nc_cleared" ] && echo 1 || echo 0)" \
                "dismissed_count=$(json_field "$nc_sweep" data.dismissed_count) remaining=$(json_field "$nc_left" data.count) (leftover fixture rows may need manual clearing)"
        else
            badmsg "NT4 skipped: second fixture notification never became observable"
        fi
    fi
fi
if [ -n "$nc_posted" ] && [ -z "$nc_found" ]; then
    "$bin" --headed dismiss-all-notifications --app "Script Editor" >/dev/null 2>&1 || true
fi
