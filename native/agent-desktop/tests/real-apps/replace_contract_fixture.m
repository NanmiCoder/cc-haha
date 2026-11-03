#import <AppKit/AppKit.h>
#import <dlfcn.h>
@interface ContractText : NSTextView
@end
@implementation ContractText
- (BOOL)accessibilityReplaceRange:(NSRange)range withText:(NSString *)text {
    NSLog(@"RECEIVED range=%@ text=%@", NSStringFromRange(range), text);
    if (range.location > self.string.length || range.length > self.string.length - range.location) return NO;
    [self.textStorage replaceCharactersInRange:range withString:text];
    NSLog(@"RESULT %@", self.string);
    return YES;
}
@end
int main(int argc, const char *argv[]) { @autoreleasepool {
    BOOL focused = argc == 2 && strcmp(argv[1], "--standard-focused") == 0;
    BOOL standard = focused || (argc == 2 && strcmp(argv[1], "--standard") == 0);
    if (argc > 1 && !standard) return 2;
    for (const char **p = (const char *[]){"NSAccessibilityReplacementRangeKey", "NSAccessibilityReplacementTextKey", "NSAccessibilityReplaceRangeWithTextParameterizedAttribute", NULL}; *p; p++) {
        NSString **symbol = dlsym(RTLD_DEFAULT, *p);
        NSLog(@"KEY %s = %@", *p, symbol ? *symbol : @"MISSING");
    }
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 400, 200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"AD Reliability Parameter Contract";
    NSTextView *text = [[(standard ? NSTextView.class : ContractText.class) alloc] initWithFrame:NSMakeRect(0,0,400,200)];
    text.string = @"seed-target";
    window.contentView = text;
    [window orderBack:nil];
    if (focused) {
        BOOL accepted = [window makeFirstResponder:text];
        NSLog(@"RESPONDER accepted=%d matches=%d active=%d key=%d currentContext=%@ editorContext=%@", accepted, window.firstResponder == text, app.active, window.keyWindow, NSTextInputContext.currentInputContext, text.inputContext);
    }
    NSLog(@"READY pid=%d", getpid());
    [app run];
} }
