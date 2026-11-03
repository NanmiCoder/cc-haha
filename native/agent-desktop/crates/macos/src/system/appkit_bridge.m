#import <AppKit/AppKit.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <math.h>

typedef struct {
    uint8_t status;
    uint8_t deliveryStarted;
} AgentDesktopTerminateResult;

typedef bool (*AgentDesktopLaunchTimeConflict)(
    double expectedLaunchTime,
    double observedLaunchTime,
    bool launchDatePresent
);

typedef struct {
    uint8_t status;
    const char *failureField;
    int32_t failureIndex;
    int32_t failurePID;
    uint8_t *bytes;
    size_t length;
} AgentDesktopBytesResult;

// Reports whether a running application has finished starting up.
// -1 no such process, 0 still starting, 1 finished.
int32_t agent_desktop_app_finished_launching(int32_t pid) {
    @try {
        @autoreleasepool {
            NSRunningApplication *app =
                [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (app == nil) {
                return -1;
            }
            return app.isFinishedLaunching ? 1 : 0;
        }
    } @catch (NSException *exception) {
        (void)exception;
        return -1;
    }
}

AgentDesktopTerminateResult agent_desktop_terminate_application(
    int32_t pid,
    double expectedLaunchTime,
    uint8_t force,
    AgentDesktopLaunchTimeConflict launchTimeConflict
) {
    AgentDesktopTerminateResult result = { .status = 4, .deliveryStarted = 0 };
    @try {
        @autoreleasepool {
            NSRunningApplication *app =
                [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (app == nil) {
                result.status = 1;
                return result;
            }
            NSDate *launchDate = app.launchDate;
            bool launchDatePresent = launchDate != nil;
            double observedLaunchTime =
                launchDatePresent ? launchDate.timeIntervalSince1970 : 0.0;
            if (launchTimeConflict == NULL ||
                launchTimeConflict(expectedLaunchTime, observedLaunchTime, launchDatePresent)) {
                result.status = 5;
                return result;
            }
            result.deliveryStarted = 1;
            BOOL accepted = force != 0 ? [app forceTerminate] : [app terminate];
            result.status = accepted ? 0 : 2;
            return result;
        }
    } @catch (NSException *exception) {
        (void)exception;
        result.status = 3;
        return result;
    }
}

uint8_t agent_desktop_ensure_cocoa_multithreaded(void) {
    @try {
        @autoreleasepool {
            if ([NSThread isMultiThreaded]) {
                return 0;
            }
            NSThread *thread = [[NSThread alloc] initWithBlock:^{}];
            if (thread == nil) {
                return 1;
            }
            [thread start];
            uint32_t remaining = 1000;
            while (!thread.isFinished && remaining > 0) {
                usleep(1000);
                remaining -= 1;
            }
            if (!thread.isFinished) {
                return 2;
            }
            return [NSThread isMultiThreaded] ? 0 : 3;
        }
    } @catch (NSException *exception) {
        (void)exception;
        return 4;
    }
}

static NSString *agent_desktop_non_blank(NSString *value) {
    NSString *trimmed = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed.length == 0 ? nil : value;
}

static NSString *agent_desktop_application_name(NSRunningApplication *app) {
    NSString *name = agent_desktop_non_blank(app.localizedName);
    if (name == nil) {
        name = agent_desktop_non_blank(app.executableURL.lastPathComponent);
    }
    if (name == nil) {
        name = agent_desktop_non_blank(app.bundleIdentifier);
    }
    return name;
}

AgentDesktopBytesResult agent_desktop_copy_workspace_snapshot_json(void) {
    AgentDesktopBytesResult result = {
        .status = 5, .failureField = NULL, .failureIndex = -1,
        .failurePID = 0, .bytes = NULL, .length = 0
    };
    @try {
        @autoreleasepool {
            NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, false);
            NSArray<NSRunningApplication *> *running = workspace.runningApplications;
            if (running == nil || running.count > 8192) {
                result.status = 1;
                return result;
            }
            NSMutableArray<NSDictionary *> *skipped = [NSMutableArray array];
            int32_t frontmostPID = 0;
            id frontmostLaunchTime = [NSNull null];
            NSRunningApplication *frontmost = workspace.frontmostApplication;
            if (frontmost != nil) {
                if (![frontmost isKindOfClass:[NSRunningApplication class]]) {
                    [skipped addObject:@{@"pid": @0, @"field": @"frontmost_class"}];
                    frontmost = nil;
                }
                frontmostPID = frontmost.processIdentifier;
                if (frontmostPID > 0) {
                    NSDate *frontmostLaunchDate = frontmost.launchDate;
                    if (frontmostLaunchDate != nil) {
                        double launchTime = frontmostLaunchDate.timeIntervalSince1970;
                        if (!isfinite(launchTime) || launchTime <= 0.0) {
                            [skipped addObject:@{@"pid": @(frontmostPID), @"field": @"frontmost_launch_time"}];
                            frontmostPID = 0;
                        }
                        if (frontmostPID > 0) {
                            frontmostLaunchTime = @(launchTime);
                        }
                    }
                } else {
                    frontmostPID = 0;
                }
            }
            NSMutableArray<NSDictionary *> *records =
                [NSMutableArray arrayWithCapacity:running.count];
            for (NSUInteger index = 0; index < running.count; index++) {
                NSRunningApplication *app = running[index];
                if (![app isKindOfClass:[NSRunningApplication class]]) {
                    [skipped addObject:@{@"pid": @(0), @"field": @"application_class", @"index": @(index)}];
                    continue;
                }
                int32_t pid = app.processIdentifier;
                if (pid <= 0) {
                    [skipped addObject:@{@"pid": @(pid), @"field": @"pid", @"index": @(index)}];
                    continue;
                }
                NSApplicationActivationPolicy policy = app.activationPolicy;
                NSString *policyName = nil;
                switch (policy) {
                    case NSApplicationActivationPolicyRegular:
                        policyName = @"regular";
                        break;
                    case NSApplicationActivationPolicyAccessory:
                        policyName = @"accessory";
                        break;
                    case NSApplicationActivationPolicyProhibited:
                        continue;
                    default:
                        [skipped addObject:@{@"pid": @(pid), @"field": @"activation_policy", @"index": @(index)}];
                        continue;
                }
                if (policyName == nil) {
                    continue;
                }
                NSString *name = agent_desktop_application_name(app);
                if (name == nil || name.length == 0 ||
                    [name lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 16384) {
                    [skipped addObject:@{@"pid": @(pid), @"field": @"application_name", @"index": @(index)}];
                    continue;
                }
                NSNumber *pidNumber = @(pid);
                NSDate *launchDate = app.launchDate;
                id launchTime = [NSNull null];
                if (launchDate != nil) {
                    double seconds = launchDate.timeIntervalSince1970;
                    if (!isfinite(seconds) || seconds <= 0.0) {
                        [skipped addObject:@{@"pid": @(pid), @"field": @"application_launch_time", @"index": @(index)}];
                        continue;
                    }
                    launchTime = @(seconds);
                }
                NSMutableDictionary *record = [@{
                    @"name": name,
                    @"pid": pidNumber,
                    @"launch_time": launchTime,
                    @"activation_policy": policyName,
                } mutableCopy];
                NSString *bundle = app.bundleIdentifier;
                if (bundle != nil) {
                    if ([bundle lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 16384) {
                        [skipped addObject:@{@"pid": @(pid), @"field": @"bundle_identifier", @"index": @(index)}];
                        continue;
                    }
                    record[@"bundle_id"] = bundle;
                }
                [records addObject:record];
            }
            NSMutableDictionary *snapshot = [@{
                @"applications": records,
                @"frontmost_pid": @(frontmostPID),
                @"frontmost_launch_time": frontmostLaunchTime,
            } mutableCopy];
            if (skipped.count > 0) {
                snapshot[@"skipped"] = skipped;
            }
            NSError *error = nil;
            NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:&error];
            if (data == nil || error != nil || data.length > 1048576) {
                result.status = 3;
                return result;
            }
            if (data.length > 0) {
                result.bytes = malloc(data.length);
                if (result.bytes == NULL) {
                    result.status = 4;
                    return result;
                }
                memcpy(result.bytes, data.bytes, data.length);
            }
            result.length = data.length;
            result.status = 0;
            return result;
        }
    } @catch (NSException *exception) {
        (void)exception;
        if (result.bytes != NULL) {
            free(result.bytes);
            result.bytes = NULL;
            result.length = 0;
        }
        result.status = 5;
        return result;
    }
}

void agent_desktop_free_bridge_bytes(uint8_t *bytes) {
    free(bytes);
}
