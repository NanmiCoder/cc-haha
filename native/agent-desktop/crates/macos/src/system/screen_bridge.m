#import <AppKit/AppKit.h>

typedef struct {
    double x;
    double y;
    double width;
    double height;
} AgentDesktopScreenRect;

bool agent_desktop_visible_frame(uint32_t displayID, AgentDesktopScreenRect *output) {
    if (output == NULL) {
        return false;
    }
    @try {
        @autoreleasepool {
            for (NSScreen *screen in NSScreen.screens) {
                NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
                if (number == nil || number.unsignedIntValue != displayID) {
                    continue;
                }
                NSRect visible = screen.visibleFrame;
                CGRect mainBounds = CGDisplayBounds(CGMainDisplayID());
                output->x = visible.origin.x;
                output->y = mainBounds.size.height - NSMaxY(visible);
                output->width = visible.size.width;
                output->height = visible.size.height;
                return true;
            }
            return false;
        }
    } @catch (NSException *exception) {
        (void)exception;
        return false;
    }
}
