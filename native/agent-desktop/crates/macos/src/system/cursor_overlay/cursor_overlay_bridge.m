#import "cursor_overlay_chrome.h"
#import <CoreGraphics/CoreGraphics.h>
#import <stdbool.h>
#import <stddef.h>
#import <stdint.h>

typedef struct {
    double x;
    double y;
    double ripple;
} AgentDesktopCursorFrame;

typedef struct {
    double frameSeconds;
    const char *label;
    double bubble[4];
    double target[4];
    double highlightSeconds;
    uint8_t flags;
} AgentDesktopCursorRenderConfig;

static const uint8_t ADReduceMotion = 1 << 2;
static const uint8_t ADHighlightCue = 1 << 3;
static const uint8_t ADPointOnArrival = 1 << 4;
static const uint8_t ADArrowOnDeparture = 1 << 5;
static const uint8_t ADArrowAfterEffect = 1 << 6;
static const double ADPointerReleaseSeconds = 0.35;
static const CGFloat ADStage = 240.0;
static const CGFloat ADBoxWidth = 32.0;
static const CGFloat ADBoxHeight = 40.0;
static const CGFloat ADTipX = 88.0;
static const CGFloat ADTipY = 172.0;
static const CGFloat ADBubbleMargin = 8.0;
static const CGFloat ADLabelPadding = 10.0;
static const CGFloat ADLabelPoints = 12.5;
static const CGFloat ADTextCellInset = 6.0;
static const float ADLabelShadowOpacity = 0.31f;
static const CGFloat ADLabelShadowOffset = 2.0;
static const CGFloat ADLabelShadowBlur = 2.5;
static const CGFloat ADHighlightPad = 5.0;

static __strong NSWindow *ADCursorWindow = nil;
static __strong CALayer *ADPointer = nil;
static __strong NSWindow *ADRipple = nil;
static __strong NSWindow *ADBubbleWindow = nil;
static __strong NSTextField *ADBubbleText = nil;
static __strong CALayer *ADBubblePill = nil;
static bool ADDragArmed = false;
static bool ADDragStarted = false;
static bool ADDragTrail = false;
static CGPoint ADDragLast = {0.0, 0.0};
static CFTimeInterval ADDragArmDeadline = 0.0;
static CFTimeInterval ADDragDeadline = 0.0;

static void ADMoveCursor(const AgentDesktopCursorFrame *frame, double mainHeight);

static void ADDragCancel(void) {
    ADDragArmed = false;
    ADDragStarted = false;
    ADTrailStop();
}

static void ADDragPoll(void) {
    if (!ADDragArmed) {
        return;
    }
    CFTimeInterval now = CACurrentMediaTime();
    bool down = CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState,
                                         kCGMouseButtonLeft);
    if (now >= ADDragDeadline || (!ADDragStarted && now >= ADDragArmDeadline)) {
        ADDragCancel();
        return;
    }
    if (!down) {
        if (ADDragStarted) {
            if (ADDragTrail) {
                ADTrailFinish(0.9);
            }
            ADDragArmed = false;
            ADDragStarted = false;
        }
        return;
    }
    CGEventRef event = CGEventCreate(NULL);
    if (event == NULL) {
        return;
    }
    CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    if (ADDragStarted && CGPointEqualToPoint(point, ADDragLast)) {
        return;
    }
    double mainHeight = CGDisplayBounds(CGMainDisplayID()).size.height;
    if (!ADDragStarted) {
        ADDragStarted = true;
        ADDragLast = point;
        if (ADDragTrail) {
            ADTrailBegin(NSMakePoint(point.x, mainHeight - point.y));
        }
    } else if (ADBubbleWindow.isVisible) {
        NSPoint origin = ADBubbleWindow.frame.origin;
        [ADBubbleWindow setFrameOrigin:NSMakePoint(origin.x + point.x - ADDragLast.x,
                                                   origin.y - point.y + ADDragLast.y)];
    }
    AgentDesktopCursorFrame frame = {.x = point.x, .y = point.y, .ripple = 0.0};
    ADMoveCursor(&frame, mainHeight);
    if (ADDragTrail) {
        ADTrailAppend(NSMakePoint(point.x, mainHeight - point.y));
    }
    ADDragLast = point;
}

static CAShapeLayer *ADDartLayer(void) {
    static const CGPoint dart[] = {
        {1.0, 35.0}, {29.6, 17.5}, {12.7, 16.3}, {4.2, 1.6},
    };
    CAShapeLayer *layer = [CAShapeLayer layer];
    CGMutablePathRef path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, dart[0].x, dart[0].y);
    for (size_t index = 1; index < sizeof(dart) / sizeof(dart[0]); index += 1) {
        CGPathAddLineToPoint(path, NULL, dart[index].x, dart[index].y);
    }
    CGPathCloseSubpath(path);
    layer.path = path;
    CGPathRelease(path);
    layer.lineWidth = 3.0;
    layer.lineJoin = kCALineJoinRound;
    layer.shadowColor = NSColor.blackColor.CGColor;
    layer.shadowOpacity = 0.32;
    layer.shadowRadius = 5.0;
    layer.shadowOffset = CGSizeMake(2.5, -3.0);
    ADFreezeLayer(layer);
    return layer;
}

static void ADTintPointer(void) {
    const AgentDesktopCursorStyle *style = ADStyle();
    CAShapeLayer *rim = (CAShapeLayer *)ADPointer.sublayers.firstObject;
    CAShapeLayer *dart = (CAShapeLayer *)ADPointer.sublayers.lastObject;
    rim.fillColor = ADColor(style->rim, 1.0);
    rim.strokeColor = ADColor(style->rim, 1.0);
    dart.fillColor = ADColor(style->fill, 1.0);
    dart.strokeColor = ADColor(style->fill, 1.0);
    ADPointer.transform = CATransform3DMakeScale(style->size, style->size, 1.0);
}

static CALayer *ADPointerLayer(void) {
    CALayer *pointer = [CALayer layer];
    pointer.bounds = CGRectMake(0.0, 0.0, ADBoxWidth, ADBoxHeight);
    pointer.anchorPoint = CGPointMake(1.0 / ADBoxWidth, 35.0 / ADBoxHeight);
    pointer.position = CGPointMake(ADTipX, ADTipY);
    ADFreezeLayer(pointer);
    CAShapeLayer *rim = ADDartLayer();
    rim.lineWidth = 6.5;
    rim.shadowOpacity = 0.34;
    [pointer addSublayer:rim];
    [pointer addSublayer:ADDartLayer()];
    return pointer;
}

static void ADMoveCursor(const AgentDesktopCursorFrame *frame, double mainHeight) {
    [ADCursorWindow setFrameOrigin:NSMakePoint(frame->x - ADTipX, mainHeight - frame->y - ADTipY)];
}

static NSFont *ADLabelFont(void) {
    static NSFont *font = nil;
    if (font == nil) {
        font = [NSFont systemFontOfSize:ADLabelPoints weight:NSFontWeightMedium];
    }
    return font;
}

/// The label pill: a black, fully rounded tag with a soft shadow, in a window
/// `ADBubbleMargin` larger on every side so the shadow is not clipped. Its
/// size comes from the label's measured width; see `ADLayoutBubble`.
static NSWindow *ADBubble(void) {
    NSWindow *window = ADWindow(NSMakeRect(0.0, 0.0, 1.0, 1.0));
    ADBubblePill = [CALayer layer];
    ADBubblePill.backgroundColor = NSColor.blackColor.CGColor;
    ADBubblePill.shadowColor = NSColor.blackColor.CGColor;
    ADBubblePill.shadowOpacity = ADLabelShadowOpacity;
    ADBubblePill.shadowRadius = ADLabelShadowBlur;
    ADBubblePill.shadowOffset = CGSizeMake(0.0, -ADLabelShadowOffset);
    ADFreezeLayer(ADBubblePill);
    [window.contentView.layer addSublayer:ADBubblePill];
    ADBubbleText = [NSTextField labelWithString:@""];
    ADBubbleText.textColor = NSColor.whiteColor;
    ADBubbleText.font = ADLabelFont();
    ADBubbleText.alignment = NSTextAlignmentCenter;
    ADBubbleText.lineBreakMode = NSLineBreakByTruncatingTail;
    ADBubbleText.maximumNumberOfLines = 1;
    [window.contentView addSubview:ADBubbleText];
    return window;
}

/// Sizes the pill to `pill` and centres the text in it across and down, the
/// way `LabelPill::text_frame` places it. The text field spans the padded
/// interior, widened on each side by more than the cell's own inset so the
/// measured text is never cut short, and centres its line itself; its height is the font's line, so
/// the line sits at the pill's vertical middle.
static void ADLayoutBubble(NSSize pill) {
    ADBubblePill.frame = CGRectMake(ADBubbleMargin, ADBubbleMargin, pill.width, pill.height);
    ADBubblePill.cornerRadius = pill.height / 2.0;
    CGPathRef shadow = CGPathCreateWithRoundedRect(CGRectMake(0.0, 0.0, pill.width, pill.height),
                                                   pill.height / 2.0, pill.height / 2.0, NULL);
    ADBubblePill.shadowPath = shadow;
    CGPathRelease(shadow);
    CGFloat line = ceil([ADBubbleText.cell cellSizeForBounds:NSMakeRect(0.0, 0.0, CGFLOAT_MAX,
                                                                         CGFLOAT_MAX)]
                            .height);
    ADBubbleText.frame = NSMakeRect(ADBubbleMargin + ADLabelPadding - ADTextCellInset,
                                    ADBubbleMargin + (pill.height - line) / 2.0,
                                    MAX(pill.width - ADLabelPadding * 2.0, 0.0) +
                                        ADTextCellInset * 2.0,
                                    line);
}

double agent_desktop_cursor_overlay_label_width(const char *label) {
    if (label == NULL) {
        return 0.0;
    }
    @autoreleasepool {
        NSString *text = [NSString stringWithUTF8String:label];
        if (text == nil) {
            return 0.0;
        }
        return ceil([text sizeWithAttributes:@{NSFontAttributeName : ADLabelFont()}].width);
    }
}

void agent_desktop_cursor_overlay_idle(void) {
    @autoreleasepool {
        ADDragPoll();
        ADPump(NSApplication.sharedApplication);
    }
}

void agent_desktop_cursor_overlay_stop(void) {
    ADDragCancel();
    [ADCursorWindow orderOut:nil];
    [ADBubbleWindow orderOut:nil];
    [ADRipple orderOut:nil];
    ADHighlightStop();
    ADCaretStop();
    ADTrailStop();
    ADCursorWindow = nil;
    ADPointer = nil;
    ADRipple = nil;
    ADBubbleWindow = nil;
    ADBubbleText = nil;
    ADBubblePill = nil;
}

void agent_desktop_cursor_overlay_caret(double x, double y, double width, double height) {
    if (ADCursorWindow == nil) {
        return;
    }
    @autoreleasepool {
        double mainHeight = CGDisplayBounds(CGMainDisplayID()).size.height;
        ADCaretShow(NSMakeRect(x, mainHeight - y - height, width, height));
        ADPump(NSApplication.sharedApplication);
    }
}

void agent_desktop_cursor_overlay_caret_clear(void) {
    ADCaretStop();
}

void agent_desktop_cursor_overlay_caret_follow(bool present, double x, double y, double width,
                                               double height) {
    if (!ADCaretShowing()) {
        return;
    }
    if (present) {
        agent_desktop_cursor_overlay_caret(x, y, width, height);
        return;
    }
    @autoreleasepool {
        ADCaretStop();
        ADPump(NSApplication.sharedApplication);
    }
}

void agent_desktop_cursor_overlay_rest(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        for (double step = 1.0; step > 0.0; step -= 0.08) {
            ADCursorWindow.alphaValue = step;
            ADBubbleWindow.alphaValue = step;
            ADPump(app);
            [NSThread sleepForTimeInterval:0.012];
        }
        [ADCursorWindow orderOut:nil];
        [ADBubbleWindow orderOut:nil];
        ADCaretStop();
        ADCursorWindow.alphaValue = 1.0;
        ADBubbleWindow.alphaValue = 1.0;
        ADTrailStop();
    }
}

void agent_desktop_cursor_overlay_hide(void) {
    ADDragCancel();
    ADCaretStop();
    [ADCursorWindow orderOut:nil];
    [ADBubbleWindow orderOut:nil];
    [ADRipple orderOut:nil];
    ADHighlightStop();
    ADTrailStop();
}

void agent_desktop_cursor_overlay_drag_begin(double fromX, double fromY, bool trail) {
    @try {
        @autoreleasepool {
            (void)fromX;
            (void)fromY;
            ADDragCancel();
            ADDragArmed = true;
            ADDragTrail = trail;
            CFTimeInterval now = CACurrentMediaTime();
            ADDragArmDeadline = now + 1.0;
            ADDragDeadline = now + 95.0;
        }
    } @catch (NSException *exception) {
        (void)exception;
        ADDragCancel();
    }
}

void agent_desktop_cursor_overlay_drag_end(double toX, double toY, bool completed) {
    @try {
        @autoreleasepool {
            if (!ADDragArmed) {
                return;
            }
            if (!completed) {
                ADDragCancel();
                return;
            }
            double mainHeight = CGDisplayBounds(CGMainDisplayID()).size.height;
            AgentDesktopCursorFrame frame = {.x = toX, .y = toY, .ripple = 0.0};
            ADMoveCursor(&frame, mainHeight);
            if (ADDragTrail) {
                ADTrailAppend(NSMakePoint(toX, mainHeight - toY));
                ADTrailFinish(0.9);
            }
            ADDragArmed = false;
            ADDragStarted = false;
        }
    } @catch (NSException *exception) {
        (void)exception;
        if (ADDragArmed) {
            ADDragCancel();
        }
    }
}

bool agent_desktop_cursor_overlay_drag_active(void) {
    return ADDragArmed;
}

void agent_desktop_cursor_overlay_show(void) {
    [ADCursorWindow orderFrontRegardless];
    if (ADBubbleText.stringValue.length > 0) {
        [ADBubbleWindow orderFrontRegardless];
    }
}

static void ADHighlightTarget(const AgentDesktopCursorRenderConfig *config, double mainHeight) {
    const double *target = config->target;
    ADHighlightShow(NSMakeRect(target[0] - ADHighlightPad,
                               mainHeight - target[1] - target[3] - ADHighlightPad,
                               target[2] + ADHighlightPad * 2.0,
                               target[3] + ADHighlightPad * 2.0),
                    config->highlightSeconds);
}

bool agent_desktop_cursor_overlay_run(const AgentDesktopCursorFrame *frames,
                                      size_t frameCount,
                                      const AgentDesktopCursorRenderConfig *config) {
    if (frames == NULL || frameCount == 0 || config == NULL || config->frameSeconds <= 0.0) {
        return false;
    }
    @try {
        @autoreleasepool {
            NSApplication *app = NSApplication.sharedApplication;
            [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
            [app finishLaunching];
            double mainHeight = CGDisplayBounds(CGMainDisplayID()).size.height;
            bool reduceMotion = (config->flags & ADReduceMotion) != 0;
            const AgentDesktopCursorFrame *last = &frames[frameCount - 1];

            if (ADCursorWindow == nil) {
                ADCursorWindow = ADWindow(NSMakeRect(0.0, 0.0, ADStage, ADStage));
                ADPointer = ADPointerLayer();
                [ADCursorWindow.contentView.layer addSublayer:ADPointer];
                ADBubbleWindow = ADBubble();
                ADRipple = ADRippleWindow();
            }
            ADTintPointer();
            if ((config->flags & ADArrowOnDeparture) != 0) {
                ADPointerImageSelect(ADCursorWindow, ADPointer, false);
            }
            ADPointerImageApply(ADCursorWindow, ADPointer);
            bool pointsOnArrival = (config->flags & ADPointOnArrival) != 0;
            [ADCursorWindow orderFrontRegardless];

            bool showsBubble =
                config->label != NULL && config->label[0] != '\0' && config->bubble[2] > 0.0;
            NSString *nextLabel = showsBubble ? @(config->label) : @"";
            bool changedLabel = ![ADBubbleText.stringValue isEqualToString:nextLabel];
            ADBubbleText.stringValue = nextLabel;
            if (!showsBubble || changedLabel) {
                [ADBubbleWindow orderOut:nil];
            }
            NSRect pillFrame = NSMakeRect(config->bubble[0],
                                          mainHeight - config->bubble[1] - config->bubble[3],
                                          config->bubble[2], config->bubble[3]);
            NSRect bubbleFrame = NSInsetRect(pillFrame, -ADBubbleMargin, -ADBubbleMargin);
            if (showsBubble) {
                ADLayoutBubble(pillFrame.size);
            }
            bool followsBubble = showsBubble && !changedLabel && ADBubbleWindow.isVisible;
            [ADRipple setFrameOrigin:NSMakePoint(last->x - ADRippleSize * 0.5,
                                                 mainHeight - last->y - ADRippleSize * 0.5)];
            size_t movementFrameCount = frameCount;
            bool playsRipple = false;
            for (size_t index = 0; index < frameCount; index += 1) {
                if (frames[index].ripple > 0.0) {
                    movementFrameCount = index;
                    playsRipple = true;
                    break;
                }
            }
            bool highlighted = (config->flags & ADHighlightCue) == 0 || reduceMotion;

            for (size_t index = 0; index < movementFrameCount; index += 1) {
                ADMoveCursor(&frames[index], mainHeight);
                if (pointsOnArrival && frames[index].x == last->x && frames[index].y == last->y) {
                    ADPointerImageSelect(ADCursorWindow, ADPointer, true);
                    pointsOnArrival = false;
                }
                if (followsBubble) {
                    [ADBubbleWindow setFrameOrigin:NSMakePoint(
                        bubbleFrame.origin.x + frames[index].x - last->x,
                        bubbleFrame.origin.y - frames[index].y + last->y)];
                }
                ADPump(app);
                if (index + 1 < movementFrameCount) {
                    [NSThread sleepForTimeInterval:config->frameSeconds];
                }
            }
            if (playsRipple) {
                ADRipplePlay(ADRipple);
                if (!highlighted) {
                    ADHighlightTarget(config, mainHeight);
                    highlighted = true;
                }
            }
            if (!highlighted) {
                ADHighlightTarget(config, mainHeight);
            }

            if (showsBubble) {
                ADShowBubble(ADBubbleText, bubbleFrame, changedLabel && !reduceMotion);
            } else {
                [ADBubbleWindow orderOut:nil];
            }
            if ((config->flags & ADArrowAfterEffect) != 0) {
                ADPointerImageRelease(ADCursorWindow, ADPointer, ADPointerReleaseSeconds);
            }
            return true;
        }
    } @catch (NSException *exception) {
        (void)exception;
        return false;
    }
}
