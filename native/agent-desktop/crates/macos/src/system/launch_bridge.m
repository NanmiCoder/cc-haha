#import <AppKit/AppKit.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    void *application;
    int32_t pid;
    double launchTime;
    uint8_t terminated;
    uint8_t deliveryStarted;
    uint8_t errorKind;
    const char *error;
    size_t errorLength;
} AgentDesktopLaunchResult;

typedef void (*AgentDesktopLaunchCompletion)(void *, const AgentDesktopLaunchResult *);
typedef void (*AgentDesktopLaunchRelease)(void *);

typedef struct {
    void *context;
    AgentDesktopLaunchRelease releaseContext;
    bool released;
} AgentDesktopLaunchReleaseBox;

static void releaseBox(AgentDesktopLaunchReleaseBox *box) {
    if (box == NULL) {
        return;
    }
    if (!box->released) {
        box->released = true;
        box->releaseContext(box->context);
    }
    free(box);
}

@interface AgentDesktopLaunchContext : NSObject {
@public
    AgentDesktopLaunchReleaseBox *_releaseBox;
    AgentDesktopLaunchCompletion _completion;
}
@end

@implementation AgentDesktopLaunchContext
- (void)dealloc {
    @try {
        releaseBox(_releaseBox);
        _releaseBox = NULL;
    } @catch (NSException *exception) {
        (void)exception;
    }
}
@end

static void completeError(
    AgentDesktopLaunchContext *holder,
    NSString *message,
    uint8_t kind,
    uint8_t deliveryStarted
) {
    const char *bytes = message.UTF8String;
    AgentDesktopLaunchResult result = {
        .application = NULL,
        .pid = 0,
        .launchTime = 0.0,
        .terminated = true,
        .deliveryStarted = deliveryStarted,
        .errorKind = kind,
        .error = bytes,
        .errorLength = bytes == NULL ? 0 : strlen(bytes),
    };
    holder->_completion(holder->_releaseBox->context, &result);
}

static BOOL isStringArray(id value) {
    if (![value isKindOfClass:[NSArray class]]) {
        return NO;
    }
    for (id item in (NSArray *)value) {
        if (![item isKindOfClass:[NSString class]]) {
            return NO;
        }
    }
    return YES;
}

static BOOL isStringDictionary(id value) {
    if (![value isKindOfClass:[NSDictionary class]]) {
        return NO;
    }
    for (id key in (NSDictionary *)value) {
        if (![key isKindOfClass:[NSString class]] ||
            ![value[key] isKindOfClass:[NSString class]]) {
            return NO;
        }
    }
    return YES;
}

bool agent_desktop_open_application(
    const uint8_t *requestBytes,
    size_t requestLength,
    void *context,
    AgentDesktopLaunchCompletion completion,
    AgentDesktopLaunchRelease releaseContext
) {
    AgentDesktopLaunchReleaseBox *box = calloc(1, sizeof(*box));
    if (box == NULL) {
        releaseContext(context);
        return false;
    }
    box->context = context;
    box->releaseContext = releaseContext;
    AgentDesktopLaunchContext *holder = nil;
    @try {
        holder = [AgentDesktopLaunchContext new];
        if (holder == nil) {
            releaseBox(box);
            return false;
        }
        holder->_releaseBox = box;
        holder->_completion = completion;
        box = NULL;
        NSData *data = [NSData dataWithBytes:requestBytes length:requestLength];
        NSError *jsonError = nil;
        id decoded = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
        if (![decoded isKindOfClass:[NSDictionary class]]) {
            completeError(holder, jsonError.localizedDescription ?: @"Invalid launch request", 2, 0);
            return true;
        }
        NSDictionary *request = (NSDictionary *)decoded;
        NSString *identifier = request[@"identifier"];
        NSArray *arguments = request[@"arguments"];
        NSDictionary *environment = request[@"environment"];
        if (![identifier isKindOfClass:[NSString class]] ||
            !isStringArray(arguments) || !isStringDictionary(environment)) {
            completeError(holder, @"Invalid launch request fields", 2, 0);
            return true;
        }
        NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
        NSURL *url = nil;
        if ([request[@"bundle_id"] boolValue]) {
            url = [workspace URLForApplicationWithBundleIdentifier:identifier];
        } else {
            NSString *path = [workspace fullPathForApplication:identifier];
            if (path != nil) {
                url = [NSURL fileURLWithPath:path];
            }
        }
        if (url == nil) {
            completeError(holder, @"Application bundle was not found", 1, 0);
            return true;
        }
        NSWorkspaceOpenConfiguration *configuration =
            [NSWorkspaceOpenConfiguration configuration];
        configuration.activates = [request[@"activates"] boolValue];
        configuration.promptsUserIfNeeded = [request[@"prompts"] boolValue];
        configuration.allowsRunningApplicationSubstitution =
            [request[@"substitution"] boolValue];
        configuration.createsNewApplicationInstance = [request[@"new_instance"] boolValue];
        configuration.arguments = arguments;
        configuration.environment = environment;
        [workspace openApplicationAtURL:url
                         configuration:configuration
                     completionHandler:^(NSRunningApplication *app, NSError *error) {
            @try {
                if (error != nil || app == nil) {
                    completeError(
                        holder,
                        error.localizedDescription ?: @"Launch Services returned no application",
                        4,
                        1
                    );
                    return;
                }
                NSDate *launchDate = app.launchDate;
                AgentDesktopLaunchResult result = {
                    .application = (__bridge void *)app,
                    .pid = app.processIdentifier,
                    .launchTime = launchDate == nil ? 0.0 : launchDate.timeIntervalSince1970,
                    .terminated = app.isTerminated,
                    .deliveryStarted = 1,
                    .errorKind = 0,
                    .error = NULL,
                    .errorLength = 0,
                };
                holder->_completion(holder->_releaseBox->context, &result);
            } @catch (NSException *exception) {
                completeError(holder, exception.reason ?: @"Launch callback exception", 3, 1);
            }
        }];
    } @catch (NSException *exception) {
        if (holder != nil && holder->_releaseBox != NULL) {
            @try {
                completeError(holder, exception.reason ?: @"Launch bridge exception", 3, 0);
            } @catch (NSException *completionException) {
                (void)completionException;
            }
            return true;
        }
        releaseBox(box);
        return false;
    }
    return true;
}

uint8_t agent_desktop_running_application_is_live(void *application, int32_t expectedPID) {
    @try {
        NSRunningApplication *app = (__bridge NSRunningApplication *)application;
        return app != nil && !app.isTerminated && app.processIdentifier == expectedPID;
    } @catch (NSException *exception) {
        (void)exception;
        return 0;
    }
}
