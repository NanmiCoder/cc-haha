#import "cursor_overlay_chrome.h"
#import <stdbool.h>
#import <fcntl.h>
#import <stdint.h>
#import <sys/stat.h>
#import <unistd.h>

static const off_t ADImageMaxBytes = 2 * 1024 * 1024;
static const uint32_t ADImageMaxPixels = 1024;
static const uint8_t ADImageSlots = 2;
static const uint8_t ADArrowSlot = 0;
static const uint8_t ADPointerSlot = 1;

@interface ADCursorImageSlot : NSObject
@property(nonatomic, copy) NSString *path;
@property(nonatomic) CGPoint hotspot;
@property(nonatomic, strong) NSImage *loaded;
@property(nonatomic) bool known;
@property(nonatomic) struct timespec modified;
@property(nonatomic) off_t bytes;
@property(nonatomic) dev_t device;
@property(nonatomic) ino_t inode;
@property(nonatomic, strong) NSBitmapImageRep *raster;
@property(nonatomic) CGSize rasterPixels;
@end

@implementation ADCursorImageSlot
@end

static __strong NSArray<ADCursorImageSlot *> *ADImageSlotList = nil;
static __strong CALayer *ADImageLayer = nil;
static uint8_t ADImageShown = 0;
static uint64_t ADImageSelections = 0;

static ADCursorImageSlot *ADImageSlot(uint8_t slot) {
    if (ADImageSlotList == nil) {
        NSMutableArray *slots = [NSMutableArray array];
        for (uint8_t index = 0; index < ADImageSlots; index += 1) {
            [slots addObject:[ADCursorImageSlot new]];
        }
        ADImageSlotList = slots;
    }
    return slot < ADImageSlots ? ADImageSlotList[slot] : nil;
}

bool agent_desktop_cursor_overlay_image(uint8_t slot,
                                        const char *path,
                                        double hotspotX,
                                        double hotspotY) {
    @autoreleasepool {
        ADCursorImageSlot *image = ADImageSlot(slot);
        if (image == nil) {
            return false;
        }
        image.path = path == NULL ? nil : [NSString stringWithUTF8String:path];
        image.hotspot = CGPointMake(hotspotX, hotspotY);
        image.loaded = nil;
        image.known = false;
        image.raster = nil;
        image.rasterPixels = CGSizeZero;
        return path == NULL || image.path != nil;
    }
}

static uint32_t ADImageBigEndian(const uint8_t *bytes) {
    return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) |
           (uint32_t)bytes[3];
}

static bool ADImagePixelsFit(NSData *data) {
    static const uint8_t png[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
    const uint8_t *bytes = data.bytes;
    if (data.length < 8 || memcmp(bytes, png, sizeof(png)) != 0) {
        return false;
    }
    if (data.length < 24 || memcmp(bytes + 12, "IHDR", 4) != 0) {
        return false;
    }
    uint32_t width = ADImageBigEndian(bytes + 16);
    uint32_t height = ADImageBigEndian(bytes + 20);
    return width > 0 && height > 0 && width <= ADImageMaxPixels && height <= ADImageMaxPixels;
}

static NSData *ADImageRead(NSString *path, struct stat *info) {
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        return nil;
    }
    NSMutableData *data = nil;
    if (fstat(fd, info) == 0 && S_ISREG(info->st_mode) && info->st_size > 0 &&
        info->st_size <= ADImageMaxBytes) {
        data = [NSMutableData dataWithLength:(NSUInteger)info->st_size];
        size_t total = 0;
        while (total < data.length) {
            ssize_t count = read(fd, (uint8_t *)data.mutableBytes + total, data.length - total);
            if (count <= 0) {
                break;
            }
            total += (size_t)count;
        }
        if (total != data.length) {
            data = nil;
        }
    }
    close(fd);
    return data;
}

static NSImage *ADImageCurrent(ADCursorImageSlot *slot) {
    if (slot.path == nil) {
        return nil;
    }
    struct stat info;
    if (stat(slot.path.fileSystemRepresentation, &info) != 0) {
        slot.loaded = nil;
        slot.known = false;
        return nil;
    }
    bool unchanged = slot.known && info.st_dev == slot.device && info.st_ino == slot.inode &&
                     info.st_size == slot.bytes &&
                     info.st_mtimespec.tv_sec == slot.modified.tv_sec &&
                     info.st_mtimespec.tv_nsec == slot.modified.tv_nsec;
    if (unchanged) {
        return slot.loaded;
    }
    NSData *data = ADImageRead(slot.path, &info);
    NSImage *image = nil;
    @try {
        if (data != nil && ADImagePixelsFit(data)) {
            image = [[NSImage alloc] initWithData:data];
            if (!image.isValid || !isfinite(image.size.width) || !isfinite(image.size.height) ||
                image.size.width <= 0.0 || image.size.height <= 0.0) {
                image = nil;
            }
        }
    } @catch (NSException *exception) {
        image = nil;
    }
    slot.loaded = image;
    slot.known = true;
    slot.modified = info.st_mtimespec;
    slot.bytes = info.st_size;
    slot.device = info.st_dev;
    slot.inode = info.st_ino;
    slot.raster = nil;
    slot.rasterPixels = CGSizeZero;
    return slot.loaded;
}

static CALayer *ADImageLayerCreate(void) {
    CALayer *layer = [CALayer layer];
    layer.actions = @{
        @"transform" : NSNull.null,
        @"opacity" : NSNull.null,
        @"position" : NSNull.null,
        @"bounds" : NSNull.null,
        @"hidden" : NSNull.null,
        @"anchorPoint" : NSNull.null,
        @"contents" : NSNull.null,
        @"contentsScale" : NSNull.null,
    };
    return layer;
}

static CGFloat ADImageFit(CGFloat extent, CGFloat room) {
    return extent > room && extent > 0.0 ? room / extent : 1.0;
}

static id ADImageRasterize(ADCursorImageSlot *slot, NSImage *image, CGSize pixels) {
    if (!isfinite(pixels.width) || !isfinite(pixels.height) ||
        pixels.width <= 0.0 || pixels.height <= 0.0 ||
        pixels.width > ADImageMaxPixels || pixels.height > ADImageMaxPixels) {
        return nil;
    }
    if (CGSizeEqualToSize(pixels, slot.rasterPixels) && slot.raster != nil) {
        return (__bridge id)slot.raster.CGImage;
    }
    NSBitmapImageRep *raster =
        [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                pixelsWide:(NSInteger)pixels.width
                                                pixelsHigh:(NSInteger)pixels.height
                                             bitsPerSample:8
                                           samplesPerPixel:4
                                                  hasAlpha:YES
                                                  isPlanar:NO
                                            colorSpaceName:NSDeviceRGBColorSpace
                                               bytesPerRow:0
                                              bitsPerPixel:0];
    NSGraphicsContext *context =
        raster == nil ? nil : [NSGraphicsContext graphicsContextWithBitmapImageRep:raster];
    if (context == nil) {
        return nil;
    }
    [NSGraphicsContext saveGraphicsState];
    @try {
        NSGraphicsContext.currentContext = context;
        context.imageInterpolation = NSImageInterpolationHigh;
        [image drawInRect:NSMakeRect(0.0, 0.0, pixels.width, pixels.height)
                 fromRect:NSZeroRect
                operation:NSCompositingOperationCopy
                 fraction:1.0];
    } @catch (NSException *exception) {
        return nil;
    } @finally {
        [NSGraphicsContext restoreGraphicsState];
    }
    slot.raster = raster;
    slot.rasterPixels = pixels;
    return (__bridge id)slot.raster.CGImage;
}

static bool ADImageDraw(NSWindow *window, CALayer *pointer, ADCursorImageSlot *slot) {
    NSImage *image = ADImageCurrent(slot);
    CALayer *stage = window.contentView.layer;
    if (image == nil || stage == nil || pointer == nil) {
        return false;
    }
    if (ADImageLayer == nil) {
        ADImageLayer = ADImageLayerCreate();
    }
    if (ADImageLayer.superlayer != stage) {
        [stage addSublayer:ADImageLayer];
    }
    NSSize size = image.size;
    CGFloat hotspotX = MIN(MAX(slot.hotspot.x, 0.0), size.width);
    CGFloat hotspotY = MIN(MAX(slot.hotspot.y, 0.0), size.height);
    CGPoint tip = pointer.position;
    CGSize room = stage.bounds.size;
    CGFloat scale = ADStyle()->size;
    scale *= MIN(MIN(ADImageFit(hotspotX * scale, tip.x),
                     ADImageFit((size.width - hotspotX) * scale, room.width - tip.x)),
                 MIN(ADImageFit(hotspotY * scale, room.height - tip.y),
                     ADImageFit((size.height - hotspotY) * scale, tip.y)));
    CGSize points = CGSizeMake(size.width * scale, size.height * scale);
    CGFloat backing = window.backingScaleFactor > 0.0 ? window.backingScaleFactor : 1.0;
    id contents = ADImageRasterize(
        slot, image, CGSizeMake(ceil(points.width * backing), ceil(points.height * backing)));
    if (contents == nil) {
        return false;
    }
    ADImageLayer.bounds = CGRectMake(0.0, 0.0, points.width, points.height);
    ADImageLayer.anchorPoint = CGPointMake(hotspotX / size.width, 1.0 - hotspotY / size.height);
    ADImageLayer.position = tip;
    ADImageLayer.contents = contents;
    ADImageLayer.contentsScale = backing;
    ADImageLayer.hidden = NO;
    return true;
}

void ADPointerImageApply(NSWindow *window, CALayer *pointer) {
    bool drawn = (ADImageShown == ADPointerSlot &&
                  ADImageDraw(window, pointer, ADImageSlot(ADPointerSlot))) ||
                 ADImageDraw(window, pointer, ADImageSlot(ADArrowSlot));
    if (!drawn) {
        [ADImageLayer removeFromSuperlayer];
    }
    pointer.hidden = drawn;
}

void ADPointerImageSelect(NSWindow *window, CALayer *pointer, bool pointing) {
    ADImageSelections += 1;
    uint8_t next = pointing ? ADPointerSlot : ADArrowSlot;
    if (next == ADImageShown) {
        return;
    }
    ADImageShown = next;
    ADPointerImageApply(window, pointer);
}

void ADPointerImageRelease(NSWindow *window, CALayer *pointer, double seconds) {
    if (ADImageShown != ADPointerSlot) {
        return;
    }
    uint64_t scheduled = ADImageSelections;
    __weak NSWindow *weakWindow = window;
    __weak CALayer *weakPointer = pointer;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
                       NSWindow *strongWindow = weakWindow;
                       CALayer *strongPointer = weakPointer;
                       if (scheduled == ADImageSelections && strongWindow != nil &&
                           strongPointer != nil) {
                           ADPointerImageSelect(strongWindow, strongPointer, false);
                       }
                   });
}
