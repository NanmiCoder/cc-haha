#import <AppKit/AppKit.h>
int main(void) { @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(300,200,500,600) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"AD Reliability Nested Scroll";
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(50,50,300,100)];
    scroll.hasVerticalScroller = YES;
    NSView *document = [[NSView alloc] initWithFrame:NSMakeRect(0,0,280,500)];
    NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(20,220,200,30)];
    button.title = @"Clipped target";
    [document addSubview:button];
    scroll.documentView = document;
    [window.contentView addSubview:scroll];
    NSButton *sibling = [[NSButton alloc] initWithFrame:NSMakeRect(250,500,200,30)];
    sibling.title = @"Visible sibling";
    [window.contentView addSubview:sibling];
    [scroll.contentView scrollToPoint:NSMakePoint(0,0)];
    [scroll reflectScrolledClipView:scroll.contentView];
    [window orderBack:nil];
    NSLog(@"READY pid=%d clip=%@ target=%@", getpid(), NSStringFromRect(scroll.contentView.bounds), NSStringFromRect(button.frame));
    [app run];
} }
