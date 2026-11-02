#import "../../crates/macos/src/system/appkit_bridge.m"
#import <objc/runtime.h>

static void require(bool condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "%s\n", message);
        exit(1);
    }
}

@interface InventoryTestApplication : NSRunningApplication
@property(nonatomic, copy) NSString *testName;
@property(nonatomic, copy) NSURL *testExecutable;
@property(nonatomic, copy) NSString *testBundle;
@property(nonatomic) pid_t testPID;
@property(nonatomic) NSApplicationActivationPolicy testPolicy;
@property(nonatomic, copy) NSDate *testLaunchDate;
@end

@implementation InventoryTestApplication
- (NSString *)localizedName { return self.testName; }
- (NSURL *)executableURL { return self.testExecutable; }
- (NSString *)bundleIdentifier { return self.testBundle; }
- (pid_t)processIdentifier { return self.testPID; }
- (NSApplicationActivationPolicy)activationPolicy { return self.testPolicy; }
- (NSDate *)launchDate { return self.testLaunchDate; }
@end

static NSArray *testApplications;
static NSRunningApplication *testFrontmost;

@interface NSWorkspace (InventoryNameTest)
- (NSArray *)inventoryTestApplications;
- (NSRunningApplication *)inventoryTestFrontmost;
@end

@implementation NSWorkspace (InventoryNameTest)
- (NSArray *)inventoryTestApplications { return testApplications; }
- (NSRunningApplication *)inventoryTestFrontmost { return testFrontmost; }
@end

static InventoryTestApplication *application(NSString *name, NSString *executable, NSString *bundle, pid_t pid) {
    InventoryTestApplication *app = [InventoryTestApplication new];
    app.testName = name;
    app.testExecutable = executable == nil ? nil : [NSURL fileURLWithPath:executable];
    app.testBundle = bundle;
    app.testPID = pid;
    app.testPolicy = NSApplicationActivationPolicyAccessory;
    app.testLaunchDate = [NSDate dateWithTimeIntervalSince1970:100];
    return app;
}

static NSDictionary *snapshot(void) {
    AgentDesktopBytesResult result = agent_desktop_copy_workspace_snapshot_json();
    require(result.status == 0, "snapshot status");
    NSData *data = [NSData dataWithBytes:result.bytes length:result.length];
    agent_desktop_free_bridge_bytes(result.bytes);
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    require(value != nil, "snapshot json");
    return value;
}

int main(void) {
    @autoreleasepool {
        method_exchangeImplementations(class_getInstanceMethod(NSWorkspace.class, @selector(runningApplications)),
            class_getInstanceMethod(NSWorkspace.class, @selector(inventoryTestApplications)));
        method_exchangeImplementations(class_getInstanceMethod(NSWorkspace.class, @selector(frontmostApplication)),
            class_getInstanceMethod(NSWorkspace.class, @selector(inventoryTestFrontmost)));
        testApplications = @[
            application(@"Approval Box", @"/tmp/ApprovalBox", @"dev.example.approvalbox", 10),
            application(@"", @"/System/FollowUpUI", @"com.apple.FollowUpUI", 11),
            application(nil, @"/tmp/Unnamed", @"dev.example.unnamed", 12),
            application(nil, nil, @"dev.example.bundle", 13),
            application(@" \t\n", @"/tmp/Blank", @"dev.example.blank", 16)
        ];
        NSArray *records = snapshot()[@"applications"];
        require(records.count == 5, "record count");
        require([records[0][@"name"] isEqualToString:@"Approval Box"], "name 0");
        require([records[1][@"name"] isEqualToString:@"FollowUpUI"], "name 1");
        require([records[2][@"name"] isEqualToString:@"Unnamed"], "name 2");
        require([records[3][@"name"] isEqualToString:@"dev.example.bundle"], "name 3");
        require([records[4][@"name"] isEqualToString:@"Blank"], "whitespace-only name falls back");
        require([records[1][@"pid"] intValue] == 11, "fallback pid");
        require([records[1][@"bundle_id"] isEqualToString:@"com.apple.FollowUpUI"], "fallback bundle id");
        require([records[1][@"launch_time"] doubleValue] == 100.0, "fallback launch time");
        require([records[1][@"activation_policy"] isEqualToString:@"accessory"], "fallback activation policy");
        require(snapshot()[@"skipped"] == nil, "no empty skipped array");
        InventoryTestApplication *valid = application(@"Valid", nil, nil, 10);
        InventoryTestApplication *policy = application(@"Policy", nil, nil, 20);
        policy.testPolicy = (NSApplicationActivationPolicy)99;
        InventoryTestApplication *launch = application(@"Launch", nil, nil, 21);
        launch.testLaunchDate = [NSDate dateWithTimeIntervalSince1970:-1];
        NSString *oversized = [@"x" stringByPaddingToLength:16385 withString:@"x" startingAtIndex:0];
        NSArray *invalid = @[
            application(nil, nil, nil, 14),
            application(oversized, nil, nil, 15),
            policy, launch, application(@"Bundle", nil, oversized, 22),
            @"wrong class", application(@"Invalid PID", nil, nil, -1)
        ];
        NSArray *fields = @[@"application_name", @"application_name", @"activation_policy",
            @"application_launch_time", @"bundle_identifier", @"application_class", @"pid"];
        NSArray *pids = @[@14, @15, @20, @21, @22, @0, @(-1)];
        for (NSUInteger index = 0; index < invalid.count; index++) {
            testApplications = @[valid, invalid[index], application(@"Later", nil, nil, 30)];
            NSDictionary *value = snapshot();
            NSArray *remaining = value[@"applications"];
            require(remaining.count == 2, "valid records survive malformed record");
            require([remaining[0][@"pid"] intValue] == 10, "first valid pid");
            require([remaining[1][@"pid"] intValue] == 30, "later valid pid");
            NSArray *skipped = value[@"skipped"];
            require(skipped.count == 1, "one skipped record");
            require([skipped[0][@"field"] isEqualToString:fields[index]], "skip field");
            require([skipped[0][@"pid"] isEqual:pids[index]], "skip pid");
        }
        testApplications = @[valid, valid, application(@"Conflicting", nil, nil, 10)];
        NSDictionary *duplicates = snapshot();
        NSArray *duplicateRecords = duplicates[@"applications"];
        require(duplicateRecords.count == 3, "duplicate records reach identity validation");
        require([duplicateRecords[0] isEqual:duplicateRecords[1]], "identical duplicate is preserved");
        require([duplicateRecords[2][@"pid"] intValue] == 10, "conflicting duplicate pid is preserved");
        require([duplicateRecords[2][@"name"] isEqualToString:@"Conflicting"], "conflicting identity is preserved");
        require(duplicates[@"skipped"] == nil, "bridge does not classify duplicate identities");
        testApplications = @[valid];
        testFrontmost = launch;
        NSDictionary *frontmostSnapshot = snapshot();
        require([frontmostSnapshot[@"applications"] count] == 1, "invalid frontmost retains owners");
        require([frontmostSnapshot[@"frontmost_pid"] intValue] == 0, "invalid frontmost omitted");
        require([frontmostSnapshot[@"skipped"][0][@"field"] isEqualToString:@"frontmost_launch_time"], "frontmost skip field");
        testFrontmost = nil;
        testApplications = nil;
        AgentDesktopBytesResult missing = agent_desktop_copy_workspace_snapshot_json();
        require(missing.status == 1, "missing snapshot remains failure");
        require(missing.bytes == NULL, "missing snapshot has no bytes");
        puts("AppKit inventory name regression tests passed");
    }
    return 0;
}
