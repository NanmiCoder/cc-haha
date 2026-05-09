#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

typedef void (*CCHHNotificationResponseCallback)(const char *target_json);

@interface CCHHNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

static CCHHNotificationResponseCallback cchhNotificationResponseCallback = NULL;

static void cchh_emit_notification_response(NSString *target) {
    if (cchhNotificationResponseCallback == NULL) {
        return;
    }

    const char *targetJson = target != nil ? [target UTF8String] : NULL;
    cchhNotificationResponseCallback(targetJson);
}

@implementation CCHHNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    if (@available(macOS 11.0, *)) {
        completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
    } else {
        completionHandler(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    NSString *target = response.notification.request.content.userInfo[@"cchh_target"];
    cchh_emit_notification_response(target);
    completionHandler();
}
@end

@interface CCHHUserNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

@implementation CCHHUserNotificationDelegate
- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center shouldPresentNotification:(NSUserNotification *)notification {
    return YES;
}

- (void)userNotificationCenter:(NSUserNotificationCenter *)center didActivateNotification:(NSUserNotification *)notification {
    NSString *target = notification.userInfo[@"cchh_target"];
    cchh_emit_notification_response(target);
}
@end

static CCHHNotificationDelegate *cchhNotificationDelegate = nil;
static CCHHUserNotificationDelegate *cchhUserNotificationDelegate = nil;

static void cchh_copy_error(char *buffer, uintptr_t buffer_len, NSString *message) {
    if (buffer == NULL || buffer_len == 0) {
        return;
    }

    buffer[0] = '\0';
    if (message == nil) {
        return;
    }

    const char *utf8 = [message UTF8String];
    if (utf8 == NULL) {
        return;
    }

    size_t max_len = (size_t)buffer_len - 1;
    strncpy(buffer, utf8, max_len);
    buffer[max_len] = '\0';
}

static void cchh_run_on_main_sync(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }

    dispatch_sync(dispatch_get_main_queue(), block);
}

void cchh_set_notification_response_callback(CCHHNotificationResponseCallback callback) {
    cchhNotificationResponseCallback = callback;
}

static UNUserNotificationCenter *cchh_notification_center(void) {
    static dispatch_once_t onceToken;
    static UNUserNotificationCenter *center = nil;

    dispatch_once(&onceToken, ^{
        center = [UNUserNotificationCenter currentNotificationCenter];
        cchhNotificationDelegate = [[CCHHNotificationDelegate alloc] init];
        center.delegate = cchhNotificationDelegate;
    });

    return center;
}

static NSUserNotificationCenter *cchh_user_notification_center(void) {
    static dispatch_once_t onceToken;
    static NSUserNotificationCenter *center = nil;

    dispatch_once(&onceToken, ^{
        center = [NSUserNotificationCenter defaultUserNotificationCenter];
        cchhUserNotificationDelegate = [[CCHHUserNotificationDelegate alloc] init];
        center.delegate = cchhUserNotificationDelegate;
    });

    return center;
}

int cchh_notification_authorization_status(char *error_buffer, uintptr_t error_buffer_len) {
    @autoreleasepool {
        cchh_copy_error(error_buffer, error_buffer_len, nil);

        if (@available(macOS 10.14, *)) {
            __block NSInteger status = UNAuthorizationStatusNotDetermined;
            dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

            cchh_run_on_main_sync(^{
                [cchh_notification_center() getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                    status = settings.authorizationStatus;
                    dispatch_semaphore_signal(semaphore);
                }];
            });

            if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
                cchh_copy_error(error_buffer, error_buffer_len, @"Timed out while reading macOS notification permission");
                return -1;
            }

            return (int)status;
        }

        return (int)UNAuthorizationStatusAuthorized;
    }
}

bool cchh_request_notification_authorization(char *error_buffer, uintptr_t error_buffer_len) {
    @autoreleasepool {
        cchh_copy_error(error_buffer, error_buffer_len, nil);

        if (@available(macOS 10.14, *)) {
            __block BOOL granted = NO;
            __block NSError *requestError = nil;
            dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
            UNAuthorizationOptions options = UNAuthorizationOptionAlert | UNAuthorizationOptionSound;

            cchh_run_on_main_sync(^{
                [cchh_notification_center() requestAuthorizationWithOptions:options completionHandler:^(BOOL isGranted, NSError *error) {
                    granted = isGranted;
                    requestError = error;
                    dispatch_semaphore_signal(semaphore);
                }];
            });

            if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC)) != 0) {
                cchh_copy_error(error_buffer, error_buffer_len, @"Timed out while requesting macOS notification permission");
                return false;
            }

            if (requestError != nil) {
                cchh_copy_error(error_buffer, error_buffer_len, [requestError localizedDescription]);
                return false;
            }

            return granted;
        }

        return true;
    }
}

bool cchh_send_user_notification(const char *title, const char *body, const char *target, char *error_buffer, uintptr_t error_buffer_len) {
    @autoreleasepool {
        cchh_copy_error(error_buffer, error_buffer_len, nil);

        int status = cchh_notification_authorization_status(error_buffer, error_buffer_len);
        if (status < 0) {
            return false;
        }
        if (status == UNAuthorizationStatusNotDetermined || status == UNAuthorizationStatusDenied) {
            cchh_copy_error(error_buffer, error_buffer_len, @"not_authorized");
            return false;
        }

        if (@available(macOS 10.14, *)) {
            UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
            content.title = title != NULL ? [NSString stringWithUTF8String:title] : @"Claude Code Haha";
            if (body != NULL && strlen(body) > 0) {
                content.body = [NSString stringWithUTF8String:body];
            }
            if (target != NULL && strlen(target) > 0) {
                content.userInfo = @{ @"cchh_target": [NSString stringWithUTF8String:target] };
            }
            content.sound = [UNNotificationSound defaultSound];

            NSString *identifier = [[NSUUID UUID] UUIDString];
            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
            __block NSError *deliveryError = nil;
            dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

            cchh_run_on_main_sync(^{
                [cchh_notification_center() addNotificationRequest:request withCompletionHandler:^(NSError *error) {
                    deliveryError = error;
                    dispatch_semaphore_signal(semaphore);
                }];
            });

            if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
                cchh_copy_error(error_buffer, error_buffer_len, @"Timed out while delivering macOS notification");
                return false;
            }

            if (deliveryError != nil) {
                cchh_copy_error(error_buffer, error_buffer_len, [deliveryError localizedDescription]);
                return false;
            }

            return true;
        }

        NSUserNotification *notification = [[NSUserNotification alloc] init];
        notification.title = title != NULL ? [NSString stringWithUTF8String:title] : @"Claude Code Haha";
        if (body != NULL && strlen(body) > 0) {
            notification.informativeText = [NSString stringWithUTF8String:body];
        }
        if (target != NULL && strlen(target) > 0) {
            notification.userInfo = @{ @"cchh_target": [NSString stringWithUTF8String:target] };
        }
        notification.soundName = NSUserNotificationDefaultSoundName;

        [cchh_user_notification_center() deliverNotification:notification];
        return true;
    }
}
