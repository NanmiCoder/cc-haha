#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <stdbool.h>
#import <stdint.h>

typedef bool (*ADGuideGranted)(uint8_t step);

static const uint8_t ADGuideAccessibility = 1;
static const uint8_t ADGuideScreenRecording = 2;
static const NSTimeInterval ADGuideLifetime = 600;
static const NSTimeInterval ADGuideDropRetry = 15;
static const CGFloat ADGuideWidth = 340;
static const CGFloat ADGuideGap = 16;
static const CGFloat ADGuideAuroraHeight = 96;
static const float ADGuideAuroraOpacity = 0.55;
static const int ADGuideRayCount = 64;
static const CGFloat ADGuideIconSize = 48;
static const CGFloat ADGuideTileSize = 76;
static const CGFloat ADGuideGhostSize = 48;

static NSRect ADGuideSettingsFrame(void) {
    NSArray<NSRunningApplication *> *apps =
        [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"];
    if (apps.count == 0) {
        return NSZeroRect;
    }
    pid_t pid = apps.firstObject.processIdentifier;
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (list == NULL) {
        return NSZeroRect;
    }
    NSRect best = NSZeroRect;
    for (NSDictionary *window in (__bridge NSArray *)list) {
        if ([window[(id)kCGWindowOwnerPID] intValue] != pid ||
            [window[(id)kCGWindowLayer] intValue] != 0) {
            continue;
        }
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation(
                (__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) {
            continue;
        }
        if (bounds.size.width * bounds.size.height > best.size.width * best.size.height) {
            best = bounds;
        }
    }
    CFRelease(list);
    if (NSIsEmptyRect(best)) {
        return NSZeroRect;
    }
    CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
    best.origin.y = primaryHeight - best.origin.y - best.size.height;
    return best;
}

static NSScreen *ADGuideScreenFor(NSRect frame) {
    NSPoint center = NSMakePoint(NSMidX(frame), NSMidY(frame));
    for (NSScreen *screen in NSScreen.screens) {
        if (NSPointInRect(center, screen.frame)) {
            return screen;
        }
    }
    return NSScreen.mainScreen;
}

@interface ADGuideIcon : NSImageView <NSDraggingSource>
@property(nonatomic, copy) NSURL *fileURL;
@property(nonatomic, copy) void (^onDrop)(void);
@end

@implementation ADGuideIcon
- (BOOL)acceptsFirstMouse:(NSEvent *)__unused event {
    return YES;
}

- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:NSCursor.openHandCursor];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)__unused session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)__unused context {
    return NSDragOperationCopy | NSDragOperationLink | NSDragOperationGeneric;
}

- (void)mouseDown:(NSEvent *)event {
    if (self.fileURL == nil) {
        return;
    }
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:self.fileURL];
    [item setDraggingFrame:self.bounds contents:self.image];
    [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
}

- (void)draggingSession:(NSDraggingSession *)__unused session
           endedAtPoint:(NSPoint)__unused point
              operation:(NSDragOperation)operation {
    if (operation != NSDragOperationNone && self.onDrop != nil) {
        self.onDrop();
    }
}
@end

@interface ADGuidePanel : NSPanel
@end

@implementation ADGuidePanel
- (BOOL)canBecomeKeyWindow {
    return YES;
}

- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)__unused screen {
    return frameRect;
}
@end

static NSColor *ADGuideGray(CGFloat white) {
    return [NSColor colorWithWhite:white alpha:1];
}

@interface ADGuideButton : NSButton
@end

@implementation ADGuideButton
- (instancetype)initWithTitle:(NSString *)title target:(id)target action:(SEL)action {
    self = [super initWithFrame:NSZeroRect];
    if (self == nil) {
        return nil;
    }
    self.target = target;
    self.action = action;
    self.bordered = NO;
    self.wantsLayer = YES;
    self.layer.backgroundColor = NSColor.blackColor.CGColor;
    self.layer.borderColor = ADGuideGray(0.45).CGColor;
    self.layer.borderWidth = 1;
    self.layer.cornerRadius = 8;
    self.attributedTitle = [[NSAttributedString alloc]
        initWithString:title
            attributes:@{
                NSForegroundColorAttributeName : NSColor.whiteColor,
                NSFontAttributeName : [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold],
            }];
    [self.widthAnchor constraintEqualToConstant:104].active = YES;
    [self.heightAnchor constraintEqualToConstant:34].active = YES;
    return self;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)__unused event {
    return YES;
}

- (void)mouseDown:(NSEvent *)__unused event {
    [self sendAction:self.action to:self.target];
}
@end

@interface ADGuideAurora : NSView
@property(nonatomic) CGFloat builtWidth;
@end

@implementation ADGuideAurora
- (instancetype)init {
    self = [super initWithFrame:NSZeroRect];
    if (self != nil) {
        self.layer = [CALayer layer];
        self.layer.opacity = ADGuideAuroraOpacity;
        self.wantsLayer = YES;
        self.layerUsesCoreImageFilters = YES;
    }
    return self;
}

- (NSView *)hitTest:(NSPoint)__unused point {
    return nil;
}

- (void)layout {
    [super layout];
    CGRect bounds = NSRectToCGRect(self.bounds);
    if (bounds.size.width <= 0 || bounds.size.width == self.builtWidth) {
        return;
    }
    self.builtWidth = bounds.size.width;
    self.layer.sublayers = nil;
    BOOL still = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    CAGradientLayer *colors = [CAGradientLayer layer];
    colors.frame = bounds;
    colors.startPoint = CGPointMake(0, 0.5);
    colors.endPoint = CGPointMake(1, 0.5);
    colors.colors = @[
        (id)[NSColor colorWithRed:1.00 green:0.13 blue:0.30 alpha:1].CGColor,
        (id)[NSColor colorWithRed:0.93 green:0.20 blue:0.85 alpha:1].CGColor,
        (id)[NSColor colorWithRed:0.52 green:0.27 blue:1.00 alpha:1].CGColor,
        (id)[NSColor colorWithRed:0.20 green:0.42 blue:1.00 alpha:1].CGColor,
        (id)[NSColor colorWithRed:0.35 green:0.70 blue:1.00 alpha:1].CGColor,
    ];
    CALayer *rays = [CALayer layer];
    rays.frame = bounds;
    CGFloat step = bounds.size.width / ADGuideRayCount;
    for (int index = 0; index < ADGuideRayCount; index++) {
        [rays addSublayer:[self rayAt:index * step width:step * 1.8 height:bounds.size.height still:still]];
    }
    colors.mask = rays;
    [self.layer addSublayer:colors];
    CIFilter *blur = [CIFilter filterWithName:@"CIGaussianBlur"];
    [blur setValue:@3 forKey:kCIInputRadiusKey];
    self.layer.filters = blur == nil ? nil : @[ blur ];
    if (!still) {
        CABasicAnimation *drift = [CABasicAnimation animationWithKeyPath:@"locations"];
        drift.fromValue = @[ @0.0, @0.25, @0.5, @0.75, @1.0 ];
        drift.toValue = @[ @0.0, @0.32, @0.58, @0.8, @1.0 ];
        drift.duration = 6;
        drift.autoreverses = YES;
        drift.repeatCount = HUGE_VALF;
        drift.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [colors addAnimation:drift forKey:@"drift"];
    }
}

- (CALayer *)rayAt:(CGFloat)x width:(CGFloat)width height:(CGFloat)height still:(BOOL)still {
    CAGradientLayer *ray = [CAGradientLayer layer];
    ray.anchorPoint = CGPointMake(0.5, 0);
    ray.bounds = CGRectMake(0, 0, width, height);
    ray.position = CGPointMake(x + width / 4, 0);
    ray.colors = @[ (id)NSColor.whiteColor.CGColor, (id)[NSColor colorWithWhite:1 alpha:0].CGColor ];
    ray.startPoint = CGPointMake(0.5, 0);
    ray.endPoint = CGPointMake(0.5, 1);
    CGFloat low = 0.25 + arc4random_uniform(40) / 100.0;
    CGFloat high = MIN(0.92, low + 0.2 + arc4random_uniform(35) / 100.0);
    ray.opacity = 0.55 + arc4random_uniform(45) / 100.0;
    ray.transform = CATransform3DMakeScale(1, high, 1);
    if (!still) {
        CABasicAnimation *flicker = [CABasicAnimation animationWithKeyPath:@"transform.scale.y"];
        flicker.fromValue = @(low);
        flicker.toValue = @(high);
        flicker.duration = 1.2 + arc4random_uniform(220) / 100.0;
        flicker.beginTime = CACurrentMediaTime() - arc4random_uniform(300) / 100.0;
        flicker.autoreverses = YES;
        flicker.repeatCount = HUGE_VALF;
        flicker.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
        [ray addAnimation:flicker forKey:@"flicker"];
    }
    return ray;
}
@end

@interface ADGuide : NSObject
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) NSView *card;
@property(nonatomic, strong) NSWindow *stage;
@property(nonatomic, strong) CALayer *carrier;
@property(nonatomic, strong) NSTextField *stepLabel;
@property(nonatomic, strong) NSTextField *titleLabel;
@property(nonatomic, strong) NSTextField *bodyLabel;
@property(nonatomic, strong) NSTextField *reasonLabel;
@property(nonatomic, strong) NSTextField *captionLabel;
@property(nonatomic, strong) ADGuideIcon *icon;
@property(nonatomic, strong) NSImage *hostImage;
@property(nonatomic, copy) NSString *hostName;
@property(nonatomic, strong) NSDate *deadline;
@property(nonatomic, strong) NSDate *droppedAt;
@property(nonatomic) ADGuideGranted granted;
@property(nonatomic) uint8_t remaining;
@property(nonatomic) uint8_t current;
@property(nonatomic) int total;
@property(nonatomic) int completed;
@property(nonatomic) BOOL advancing;
@property(nonatomic) BOOL probing;
@property(nonatomic) NSRect lastSettings;
@end

@implementation ADGuide
- (instancetype)initWithSteps:(uint8_t)steps host:(NSString *)hostPath granted:(ADGuideGranted)granted {
    self = [super init];
    if (self == nil) {
        return nil;
    }
    _granted = granted;
    _remaining = steps;
    _total = ((steps & ADGuideAccessibility) ? 1 : 0) + ((steps & ADGuideScreenRecording) ? 1 : 0);
    _deadline = [NSDate dateWithTimeIntervalSinceNow:ADGuideLifetime];
    _hostImage = [NSWorkspace.sharedWorkspace iconForFile:hostPath];
    _hostName = [[NSFileManager.defaultManager displayNameAtPath:hostPath] stringByDeletingPathExtension];
    [self buildPanel:[NSURL fileURLWithPath:hostPath]];
    [self buildStage];
    return self;
}

- (void)buildPanel:(NSURL *)hostURL {
    self.panel = [[ADGuidePanel alloc] initWithContentRect:NSMakeRect(0, 0, ADGuideWidth, 300)
                                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
    self.panel.level = NSFloatingWindowLevel;
    self.panel.opaque = NO;
    self.panel.backgroundColor = NSColor.clearColor;
    self.panel.hasShadow = YES;
    self.panel.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    self.panel.movableByWindowBackground = YES;
    self.panel.hidesOnDeactivate = NO;
    self.panel.collectionBehavior =
        NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    [self buildFrame];
    self.stepLabel = [NSTextField labelWithString:@""];
    self.stepLabel.font = [NSFont monospacedSystemFontOfSize:10.5 weight:NSFontWeightMedium];
    self.stepLabel.textColor = ADGuideGray(0.56);
    self.titleLabel = [NSTextField wrappingLabelWithString:@""];
    self.titleLabel.alignment = NSTextAlignmentCenter;
    self.titleLabel.preferredMaxLayoutWidth = ADGuideWidth - 56;
    self.titleLabel.font = [NSFont systemFontOfSize:22 weight:NSFontWeightBold];
    self.titleLabel.textColor = NSColor.whiteColor;
    self.icon = [[ADGuideIcon alloc] init];
    self.icon.fileURL = hostURL;
    self.icon.image = self.hostImage;
    self.icon.imageScaling = NSImageScaleProportionallyUpOrDown;
    [self.icon.widthAnchor constraintEqualToConstant:ADGuideIconSize].active = YES;
    [self.icon.heightAnchor constraintEqualToConstant:ADGuideIconSize].active = YES;
    __weak ADGuide *weakSelf = self;
    self.icon.onDrop = ^{
        [weakSelf showDropped];
    };
    self.captionLabel = [NSTextField labelWithString:[NSString stringWithFormat:@"Drag %@", self.hostName]];
    self.captionLabel.font = [NSFont monospacedSystemFontOfSize:10.5 weight:NSFontWeightRegular];
    self.captionLabel.textColor = ADGuideGray(0.56);
    self.bodyLabel = [NSTextField wrappingLabelWithString:@""];
    self.bodyLabel.alignment = NSTextAlignmentCenter;
    self.bodyLabel.preferredMaxLayoutWidth = ADGuideWidth - 56;
    self.bodyLabel.textColor = ADGuideGray(0.86);
    self.bodyLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    self.reasonLabel = [NSTextField wrappingLabelWithString:@""];
    self.reasonLabel.alignment = NSTextAlignmentCenter;
    self.reasonLabel.preferredMaxLayoutWidth = ADGuideWidth - 56;
    self.reasonLabel.textColor = ADGuideGray(0.56);
    self.reasonLabel.font = [NSFont systemFontOfSize:11.5 weight:NSFontWeightRegular];
    NSButton *close = [[ADGuideButton alloc] initWithTitle:@"Not Now" target:self action:@selector(finish)];
    NSView *tile = [self tileFor:self.icon];
    NSStackView *stack = [NSStackView stackViewWithViews:@[
        tile, self.captionLabel, self.stepLabel, self.titleLabel, self.bodyLabel, self.reasonLabel, close
    ]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeCenterX;
    stack.spacing = 8;
    stack.edgeInsets = NSEdgeInsetsMake(30, 28, 52, 28);
    [stack setCustomSpacing:20 afterView:self.captionLabel];
    [stack setCustomSpacing:6 afterView:self.stepLabel];
    [stack setCustomSpacing:10 afterView:self.titleLabel];
    [stack setCustomSpacing:6 afterView:self.bodyLabel];
    [stack setCustomSpacing:30 afterView:self.reasonLabel];
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.card addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.leadingAnchor constraintEqualToAnchor:self.card.leadingAnchor],
        [stack.trailingAnchor constraintEqualToAnchor:self.card.trailingAnchor],
        [stack.topAnchor constraintEqualToAnchor:self.card.topAnchor],
        [stack.bottomAnchor constraintEqualToAnchor:self.card.bottomAnchor],
        [stack.widthAnchor constraintEqualToConstant:ADGuideWidth],
    ]];
}

- (void)buildFrame {
    self.card = [[NSView alloc] init];
    self.card.wantsLayer = YES;
    self.card.layer.backgroundColor = NSColor.blackColor.CGColor;
    self.card.layer.cornerRadius = 14;
    self.card.layer.masksToBounds = YES;
    self.card.layer.borderWidth = 1;
    self.card.layer.borderColor = ADGuideGray(0.16).CGColor;
    self.panel.contentView = self.card;
    ADGuideAurora *aurora = [[ADGuideAurora alloc] init];
    aurora.translatesAutoresizingMaskIntoConstraints = NO;
    [self.card addSubview:aurora];
    [NSLayoutConstraint activateConstraints:@[
        [aurora.leadingAnchor constraintEqualToAnchor:self.card.leadingAnchor],
        [aurora.trailingAnchor constraintEqualToAnchor:self.card.trailingAnchor],
        [aurora.bottomAnchor constraintEqualToAnchor:self.card.bottomAnchor],
        [aurora.heightAnchor constraintEqualToConstant:ADGuideAuroraHeight],
    ]];
}

- (NSView *)tileFor:(NSView *)icon {
    NSView *tile = [[NSView alloc] init];
    tile.wantsLayer = YES;
    tile.layer.backgroundColor = NSColor.blackColor.CGColor;
    tile.layer.cornerRadius = 18;
    tile.layer.borderWidth = 1.5;
    tile.layer.borderColor = ADGuideGray(0.85).CGColor;
    icon.translatesAutoresizingMaskIntoConstraints = NO;
    [tile addSubview:icon];
    [NSLayoutConstraint activateConstraints:@[
        [tile.widthAnchor constraintEqualToConstant:ADGuideTileSize],
        [tile.heightAnchor constraintEqualToConstant:ADGuideTileSize],
        [icon.centerXAnchor constraintEqualToAnchor:tile.centerXAnchor],
        [icon.centerYAnchor constraintEqualToAnchor:tile.centerYAnchor],
    ]];
    return tile;
}

- (void)buildStage {
    self.stage = [[NSWindow alloc] initWithContentRect:NSZeroRect
                                             styleMask:NSWindowStyleMaskBorderless
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.stage.opaque = NO;
    self.stage.backgroundColor = NSColor.clearColor;
    self.stage.ignoresMouseEvents = YES;
    self.stage.hasShadow = NO;
    self.stage.level = NSStatusWindowLevel;
    self.stage.collectionBehavior = self.panel.collectionBehavior;
    self.stage.contentView.wantsLayer = YES;
    self.carrier = [CALayer layer];
    self.carrier.bounds = CGRectMake(0, 0, ADGuideGhostSize, ADGuideGhostSize);
    self.carrier.opacity = 0;
    CALayer *ghost = [CALayer layer];
    ghost.frame = self.carrier.bounds;
    ghost.contents = self.hostImage;
    ghost.opacity = 0.85;
    CALayer *hand = [CALayer layer];
    NSImage *handImage = NSCursor.closedHandCursor.image;
    hand.contents = handImage;
    hand.frame = CGRectMake(ADGuideGhostSize / 2, ADGuideGhostSize / 2 - handImage.size.height,
                            handImage.size.width, handImage.size.height);
    [self.carrier addSublayer:ghost];
    [self.carrier addSublayer:hand];
    [self.stage.contentView.layer addSublayer:self.carrier];
}

- (void)start {
    [self beginStep];
    [self.panel center];
    [self follow:ADGuideSettingsFrame()];
    [self.panel orderFrontRegardless];
    [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidMoveNotification
                                                    object:self.panel
                                                     queue:nil
                                                usingBlock:^(NSNotification *__unused note) {
                                                  if (!NSIsEmptyRect(self.lastSettings)) {
                                                      [self animateInto:self.lastSettings];
                                                  }
                                                }];
    [NSTimer scheduledTimerWithTimeInterval:1
                                    repeats:YES
                                      block:^(NSTimer *__unused timer) {
                                        [self tick];
                                      }];
}

- (void)beginStep {
    self.current = (self.remaining & ADGuideAccessibility) ? ADGuideAccessibility : ADGuideScreenRecording;
    BOOL accessibility = self.current == ADGuideAccessibility;
    self.stepLabel.stringValue =
        [NSString stringWithFormat:@"STEP %d OF %d", self.completed + 1, self.total];
    NSOperatingSystemVersion renamed = {27, 0, 0};
    NSString *accessibilityList = [NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:renamed]
        ? @"Device Control and Data Access"
        : @"Accessibility";
    self.titleLabel.stringValue = accessibility ? [@"Allow " stringByAppendingString:accessibilityList]
                                                : @"Allow Screen Recording";
    self.reasonLabel.stringValue = accessibility ? @"agent-desktop needs this to see and use your apps."
                                                 : @"agent-desktop needs this to take screenshots of your apps.";
    self.reasonLabel.hidden = NO;
    [self showInstructions];
    NSString *pane = accessibility ? @"Privacy_Accessibility" : @"Privacy_ScreenCapture";
    NSOperatingSystemVersion ventura = {13, 0, 0};
    NSString *anchor = [NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:ventura]
        ? @"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?"
        : @"x-apple.systempreferences:com.apple.preference.security?";
    NSString *link = [anchor stringByAppendingString:pane];
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:link]];
    self.advancing = NO;
}

- (void)showInstructions {
    self.bodyLabel.stringValue = [NSString stringWithFormat:@"Drag %@ into the list.", self.hostName];
    self.icon.image = self.hostImage;
    self.icon.contentTintColor = nil;
    self.captionLabel.hidden = NO;
    self.droppedAt = nil;
    self.lastSettings = NSZeroRect;
    [self resizePanel];
}

- (void)retryStalledDrop {
    if (self.droppedAt != nil && [self.droppedAt timeIntervalSinceNow] < -ADGuideDropRetry) {
        [self showInstructions];
    }
}

- (void)resizePanel {
    NSRect frame = self.panel.frame;
    NSSize size = self.card.fittingSize;
    frame.origin.y += frame.size.height - size.height;
    frame.size = size;
    [self.panel setFrame:frame display:YES];
}

- (void)tick {
    if ([self.deadline timeIntervalSinceNow] <= 0) {
        [self finish];
        return;
    }
    [self follow:ADGuideSettingsFrame()];
    if (self.advancing || self.probing) {
        return;
    }
    self.probing = YES;
    uint8_t step = self.current;
    ADGuideGranted granted = self.granted;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        bool done = granted(step);
        dispatch_async(dispatch_get_main_queue(), ^{
            self.probing = NO;
            if (self.advancing || step != self.current) {
                return;
            }
            if (done) {
                [self advance];
            } else {
                [self retryStalledDrop];
            }
        });
    });
}

- (void)advance {
    self.advancing = YES;
    [self showGranted];
    self.remaining &= (uint8_t)~self.current;
    self.completed += 1;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.remaining == 0) {
            [self showDone];
        } else {
            [self beginStep];
        }
    });
}

- (void)follow:(NSRect)settings {
    if (NSEqualRects(settings, self.lastSettings)) {
        return;
    }
    self.lastSettings = settings;
    if (NSIsEmptyRect(settings)) {
        [self.stage orderOut:nil];
        return;
    }
    NSRect area = ADGuideScreenFor(settings).visibleFrame;
    NSRect frame = self.panel.frame;
    frame.origin.x = NSMaxX(settings) + ADGuideGap;
    if (NSMaxX(frame) > NSMaxX(area)) {
        frame.origin.x = NSMinX(settings) - ADGuideGap - frame.size.width;
    }
    frame.origin.x = MAX(NSMinX(area), MIN(frame.origin.x, NSMaxX(area) - frame.size.width));
    frame.origin.y = MAX(NSMinY(area), NSMaxY(settings) - frame.size.height);
    [self.panel setFrame:frame display:YES];
    [self animateInto:settings];
}

- (void)animateInto:(NSRect)settings {
    if (self.captionLabel.isHidden || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        [self.stage orderOut:nil];
        return;
    }
    NSRect screen = ADGuideScreenFor(settings).frame;
    [self.stage setFrame:screen display:NO];
    NSRect iconRect = [self.panel convertRectToScreen:[self.icon convertRect:self.icon.bounds toView:nil]];
    NSPoint from = NSMakePoint(NSMidX(iconRect) - screen.origin.x, NSMidY(iconRect) - screen.origin.y);
    NSPoint to = NSMakePoint(NSMinX(settings) + settings.size.width * 0.62 - screen.origin.x,
                             NSMinY(settings) + settings.size.height * 0.55 - screen.origin.y);
    CAKeyframeAnimation *move = [CAKeyframeAnimation animationWithKeyPath:@"position"];
    move.values = @[
        [NSValue valueWithPoint:from], [NSValue valueWithPoint:from], [NSValue valueWithPoint:to],
        [NSValue valueWithPoint:to]
    ];
    move.keyTimes = @[ @0, @0.15, @0.7, @1 ];
    move.timingFunctions = @[
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear],
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut],
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear],
    ];
    CAKeyframeAnimation *fade = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
    fade.values = @[ @0, @1, @1, @0 ];
    fade.keyTimes = @[ @0, @0.1, @0.8, @1 ];
    CAKeyframeAnimation *lift = [CAKeyframeAnimation animationWithKeyPath:@"transform.scale"];
    lift.values = @[ @1, @1.12, @1.12, @0.9 ];
    lift.keyTimes = @[ @0, @0.15, @0.7, @1 ];
    CAAnimationGroup *group = [CAAnimationGroup animation];
    group.animations = @[ move, fade, lift ];
    group.duration = 2.8;
    group.repeatCount = HUGE_VALF;
    [self.carrier removeAllAnimations];
    [self.carrier addAnimation:group forKey:@"guide"];
    [self.stage orderFrontRegardless];
}

- (void)showDropped {
    self.droppedAt = [NSDate date];
    self.captionLabel.hidden = YES;
    [self.stage orderOut:nil];
    self.bodyLabel.stringValue =
        @"Confirm with Touch ID or your password.";
    [self resizePanel];
}

- (void)showGranted {
    [self.stage orderOut:nil];
    self.captionLabel.hidden = YES;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    if ([NSImage respondsToSelector:@selector(imageWithSystemSymbolName:accessibilityDescription:)]) {
        NSImage *check = [NSImage imageWithSystemSymbolName:@"checkmark.circle.fill"
                                   accessibilityDescription:@"Granted"];
        NSImageSymbolConfiguration *config =
            [NSImageSymbolConfiguration configurationWithPointSize:48 weight:NSFontWeightRegular];
        self.icon.image = [check imageWithSymbolConfiguration:config];
        self.icon.contentTintColor = NSColor.systemGreenColor;
        [self animateTick];
    }
#pragma clang diagnostic pop
    self.bodyLabel.stringValue = @"Done.";
    [self resizePanel];
}

- (void)animateTick {
    if (NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        return;
    }
    CGFloat half = ADGuideIconSize / 2;
    CATransform3D small = CATransform3DConcat(
        CATransform3DConcat(CATransform3DMakeTranslation(-half, -half, 0), CATransform3DMakeScale(0.3, 0.3, 1)),
        CATransform3DMakeTranslation(half, half, 0));
    CASpringAnimation *pop = [CASpringAnimation animationWithKeyPath:@"transform"];
    pop.fromValue = [NSValue valueWithCATransform3D:small];
    pop.toValue = [NSValue valueWithCATransform3D:CATransform3DIdentity];
    pop.mass = 1;
    pop.stiffness = 220;
    pop.damping = 12;
    pop.duration = pop.settlingDuration;
    CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @0;
    fade.toValue = @1;
    fade.duration = 0.18;
    [self.icon.layer addAnimation:pop forKey:@"pop"];
    [self.icon.layer addAnimation:fade forKey:@"fade"];
    Class drawOn = NSClassFromString(@"NSSymbolDrawOnEffect");
    Class drawOff = NSClassFromString(@"NSSymbolDrawOffEffect");
    Class options = NSClassFromString(@"NSSymbolEffectOptions");
    if (drawOn == nil || drawOff == nil || options == nil ||
        ![self.icon respondsToSelector:@selector(addSymbolEffect:options:animated:)]) {
        return;
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    [self.icon addSymbolEffect:[drawOff effect] options:[options options] animated:NO];
    [self.icon addSymbolEffect:[drawOn effect] options:[options options] animated:YES];
#pragma clang diagnostic pop
}

- (void)showDone {
    self.reasonLabel.hidden = YES;
    self.stepLabel.stringValue = @"";
    self.titleLabel.stringValue = @"You are all set";
    self.bodyLabel.stringValue = @"agent-desktop can now see and use your apps.";
    [self resizePanel];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self finish];
    });
}

- (void)finish {
    [NSApp terminate:nil];
}
@end

int agent_desktop_permission_guide_run(uint8_t steps, const char *host_path, ADGuideGranted granted) {
    @autoreleasepool {
        NSString *host = host_path == NULL ? nil : [NSString stringWithUTF8String:host_path];
        if (steps == 0 || host.length == 0 || granted == NULL) {
            return 1;
        }
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        ADGuide *guide = [[ADGuide alloc] initWithSteps:steps host:host granted:granted];
        [guide start];
        [app run];
        return 0;
    }
}
