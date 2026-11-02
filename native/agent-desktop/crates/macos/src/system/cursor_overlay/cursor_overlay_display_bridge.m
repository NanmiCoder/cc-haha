#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <stdbool.h>

static NSRect ADTopLeftRect(NSRect frame) {
    CGRect main = CGDisplayBounds(CGMainDisplayID());
    return NSMakeRect(frame.origin.x,
                      main.size.height - NSMaxY(frame),
                      frame.size.width,
                      frame.size.height);
}

static NSScreen *ADScreenAt(double x, double y) {
    NSPoint point = NSMakePoint(x, y);
    for (NSScreen *screen in NSScreen.screens) {
        if (NSPointInRect(point, ADTopLeftRect(screen.frame))) {
            return screen;
        }
    }
    return nil;
}

bool agent_desktop_cursor_overlay_initial_point(double *output) {
    if (output == NULL) {
        return false;
    }
    @autoreleasepool {
        NSScreen *screen = NSScreen.mainScreen;
        if (screen == nil) {
            return false;
        }
        NSRect frame = ADTopLeftRect(screen.visibleFrame);
        output[0] = NSMidX(frame);
        output[1] = NSMidY(frame);
        return true;
    }
}

bool agent_desktop_cursor_overlay_screen(double x,
                                         double y,
                                         double *output) {
    if (output == NULL) {
        return false;
    }
    @try {
        @autoreleasepool {
            NSScreen *screen = ADScreenAt(x, y);
            if (screen == nil) {
                return false;
            }
            NSRect frame = ADTopLeftRect(screen.visibleFrame);
            output[0] = frame.origin.x;
            output[1] = frame.origin.y;
            output[2] = frame.size.width;
            output[3] = frame.size.height;
            double refreshRate = 60.0;
            NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
            if (screenNumber != nil) {
                CGDisplayModeRef mode = CGDisplayCopyDisplayMode(screenNumber.unsignedIntValue);
                if (mode != NULL) {
                    double reportedRate = CGDisplayModeGetRefreshRate(mode);
                    if (reportedRate > 0.0) {
                        refreshRate = reportedRate;
                    }
                    CGDisplayModeRelease(mode);
                }
            }
            output[4] = MAX(60.0, MIN(120.0, refreshRate));
            output[5] = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 1.0 : 0.0;
            return true;
        }
    } @catch (NSException *exception) {
        (void)exception;
        return false;
    }
}
