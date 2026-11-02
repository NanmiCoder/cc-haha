#import "../../crates/macos/src/system/cursor_overlay/cursor_overlay_chrome_bridge.m"
#import "../../crates/macos/src/system/cursor_overlay/cursor_overlay_image_bridge.m"
#import <unistd.h>
#import <sys/time.h>

static void require(bool condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "%s\n", message);
        exit(1);
    }
}

static NSString *writePNG(NSString *name, NSInteger width, NSInteger height) {
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                                    pixelsWide:width
                                                                    pixelsHigh:height
                                                                 bitsPerSample:8
                                                               samplesPerPixel:4
                                                                      hasAlpha:YES
                                                                      isPlanar:NO
                                                                colorSpaceName:NSDeviceRGBColorSpace
                                                                   bytesPerRow:0
                                                                  bitsPerPixel:0];
    NSString *path = [NSTemporaryDirectory()
        stringByAppendingPathComponent:[NSString stringWithFormat:@"%@-%d.png", name, getpid()]];
    NSData *data = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    require([data writeToFile:path atomically:YES], "fixture image must be written");
    return path;
}

static bool near(CGFloat left, CGFloat right) {
    return fabs(left - right) < 0.001;
}

@interface ADThrowingImage : NSImage
@end

@implementation ADThrowingImage
- (void)drawInRect:(NSRect)rect
         fromRect:(NSRect)source
        operation:(NSCompositingOperation)operation
         fraction:(CGFloat)fraction {
    [NSException raise:NSInternalInconsistencyException format:@"decode failed"];
}
@end

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSWindow *window = ADWindow(NSMakeRect(0.0, 0.0, 240.0, 240.0));
        CALayer *stage = window.contentView.layer;
        CALayer *pointer = [CALayer layer];
        pointer.position = CGPointMake(88.0, 172.0);
        [stage addSublayer:pointer];

        NSString *small = writePNG(@"ad-cursor-small", 20, 30);
        require(agent_desktop_cursor_overlay_image(0, small.fileSystemRepresentation, 4.0, 2.0),
                "image path must be accepted");
        ADPointerImageApply(window, pointer);
        require(ADImageLayer.superlayer == stage, "image must be a sibling of the pointer");
        require(pointer.sublayers.count == 0, "image must not join the arrow's sublayers");
        require(pointer.hidden && !ADImageLayer.hidden, "image must replace the arrow");
        require(near(ADImageLayer.bounds.size.width, 20.0) &&
                    near(ADImageLayer.bounds.size.height, 30.0),
                "image must keep its point size at size 1");
        require(near(ADImageLayer.anchorPoint.x, 4.0 / 20.0) &&
                    near(ADImageLayer.anchorPoint.y, 1.0 - 2.0 / 30.0),
                "hotspot must anchor the image from its top-left");
        require(CGPointEqualToPoint(ADImageLayer.position, pointer.position),
                "hotspot must sit on the cursor tip");
        require(ADImageLayer.contents != nil, "image must be rasterized");

        NSString *original = writePNG(@"ad-cursor-original", 20, 30);
        NSString *updated = writePNG(@"ad-cursor-updated", 30, 20);
        NSMutableData *originalData = [NSMutableData dataWithContentsOfFile:original];
        NSMutableData *updatedData = [NSMutableData dataWithContentsOfFile:updated];
        NSUInteger equalBytes = MAX(originalData.length, updatedData.length);
        originalData.length = updatedData.length = equalBytes;
        require([originalData writeToFile:original atomically:YES] &&
                    [updatedData writeToFile:updated atomically:YES],
                "same-size PNG fixtures must be written");
        const struct timeval times[2] = {{1700000000, 123456}, {1700000000, 123456}};
        require(utimes(original.fileSystemRepresentation, times) == 0,
                "original image mtime must be set");
        struct stat before;
        require(stat(original.fileSystemRepresentation, &before) == 0,
                "original image stat must succeed");
        agent_desktop_cursor_overlay_image(0, original.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(pointer.hidden && near(ADImageLayer.bounds.size.width, 20.0) &&
                    near(ADImageLayer.bounds.size.height, 30.0),
                "original image must be rendered before replacement");
        require(rename(updated.fileSystemRepresentation, original.fileSystemRepresentation) == 0 &&
                    utimes(original.fileSystemRepresentation, times) == 0,
                "replacement image must keep the original mtime");
        struct stat after;
        require(stat(original.fileSystemRepresentation, &after) == 0 &&
                    before.st_dev == after.st_dev && before.st_ino != after.st_ino &&
                    before.st_size == after.st_size &&
                    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
                    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
                "replacement must change inode while preserving size and mtime");
        ADPointerImageApply(window, pointer);
        require(pointer.hidden && near(ADImageLayer.bounds.size.width, 30.0) &&
                    near(ADImageLayer.bounds.size.height, 20.0),
                "same-size same-mtime replacement must render the new image");
        [[NSFileManager defaultManager] removeItemAtPath:original error:nil];

        AgentDesktopCursorStyle style = *ADStyle();
        style.size = 4.0;
        agent_desktop_cursor_overlay_style(&style);
        NSString *large = writePNG(@"ad-cursor-large", 200, 200);
        agent_desktop_cursor_overlay_image(0, large.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        CGSize fitted = ADImageLayer.bounds.size;
        require(fitted.width <= 152.0 + 0.001 && fitted.height <= 172.0 + 0.001,
                "oversized image must be scaled down to the stage");
        require(near(fitted.width, fitted.height), "downscale must be uniform");

        [[NSFileManager defaultManager] removeItemAtPath:large error:nil];
        ADPointerImageApply(window, pointer);
        require(ADImageLayer.superlayer == nil && !pointer.hidden,
                "a missing image must fall back to the arrow");

        agent_desktop_cursor_overlay_image(0, small.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(pointer.hidden, "a restored image must be drawn again");
        agent_desktop_cursor_overlay_image(0, NULL, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(ADImageLayer.superlayer == nil && !pointer.hidden,
                "clearing the image must restore the arrow");

        style.size = 1.0;
        agent_desktop_cursor_overlay_style(&style);
        NSString *hand = writePNG(@"ad-cursor-hand", 26, 28);
        agent_desktop_cursor_overlay_image(1, hand.fileSystemRepresentation, 8.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "a pointer image alone must leave the arrow until arrival");
        ADPointerImageSelect(window, pointer, true);
        require(pointer.hidden && near(ADImageLayer.bounds.size.width, 26.0) &&
                    near(ADImageLayer.anchorPoint.x, 8.0 / 26.0),
                "arrival on a control must show the pointer image at its hotspot");
        agent_desktop_cursor_overlay_image(0, small.fileSystemRepresentation, 4.0, 2.0);
        ADPointerImageSelect(window, pointer, false);
        require(pointer.hidden && near(ADImageLayer.bounds.size.width, 20.0),
                "departure must switch back to the arrow image");
        ADPointerImageSelect(window, pointer, true);
        ADPointerImageRelease(window, pointer, 0.05);
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        require(near(ADImageLayer.bounds.size.width, 20.0),
                "after an action's effect the pointer must return to the arrow");
        ADPointerImageSelect(window, pointer, true);
        ADPointerImageRelease(window, pointer, 0.05);
        ADPointerImageSelect(window, pointer, false);
        ADPointerImageSelect(window, pointer, true);
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        require(near(ADImageLayer.bounds.size.width, 26.0),
                "a release scheduled before a newer arrival must not hide that arrival's pointer");
        ADPointerImageSelect(window, pointer, false);
        agent_desktop_cursor_overlay_image(0, NULL, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "departure without an arrow image must show the built-in arrow");
        ADPointerImageSelect(window, pointer, true);
        [[NSFileManager defaultManager] removeItemAtPath:hand error:nil];
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden, "a deleted pointer image must fall back to the arrow");
        NSString *limit = writePNG(@"ad-cursor-limit", 1024, 32);
        require(ADImagePixelsFit([NSData dataWithContentsOfFile:limit]),
                "1024-pixel-wide IHDR must pass the native bound");
        agent_desktop_cursor_overlay_image(0, limit.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageSelect(window, pointer, false);
        ADPointerImageApply(window, pointer);
        require(pointer.hidden && ADImageLayer.superlayer != nil,
                "a 1024-pixel-wide PNG must be accepted");
        [[NSFileManager defaultManager] removeItemAtPath:limit error:nil];
        NSString *bomb = [NSTemporaryDirectory()
            stringByAppendingPathComponent:[NSString stringWithFormat:@"ad-cursor-bomb-%d.png", getpid()]];
        const uint8_t header[24] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 13,
                                    'I', 'H', 'D', 'R', 0, 0, 4, 1, 0, 0, 0, 32};
        require(!ADImagePixelsFit([NSData dataWithBytes:header length:sizeof(header)]),
                "1025-pixel-wide IHDR must fail the native bound");
        require([[NSData dataWithBytes:header length:sizeof(header)] writeToFile:bomb atomically:YES],
                "oversized fixture must be written");
        agent_desktop_cursor_overlay_image(0, bomb.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageSelect(window, pointer, false);
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "a PNG declaring 1025 pixels wide must fall back to the arrow");
        NSMutableData *broken = [NSMutableData dataWithBytes:header length:sizeof(header)];
        uint8_t *bytes = broken.mutableBytes;
        bytes[18] = bytes[22] = 0;
        bytes[19] = bytes[23] = 32;
        require([broken writeToFile:bomb atomically:YES], "invalid fixture must be written");
        agent_desktop_cursor_overlay_image(0, bomb.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "PNG decode failure must restore the arrow");
        ADCursorImageSlot *slot = ADImageSlot(0);
        ADThrowingImage *throwing = [[ADThrowingImage alloc] initWithSize:NSMakeSize(20, 30)];
        for (NSValue *value in @[
            [NSValue valueWithSize:NSMakeSize(0, 30)],
            [NSValue valueWithSize:NSMakeSize(-1, 30)],
            [NSValue valueWithSize:NSMakeSize(INFINITY, 30)],
            [NSValue valueWithSize:NSMakeSize(8193, 30)]
        ]) {
            require(ADImageRasterize(slot, throwing, value.sizeValue) == nil,
                    "invalid raster dimensions must be refused before allocation or drawing");
        }
        slot.path = small;
        struct stat info;
        require(stat(small.fileSystemRepresentation, &info) == 0, "fixture stat must succeed");
        slot.loaded = throwing;
        slot.known = true;
        slot.bytes = info.st_size;
        slot.device = info.st_dev;
        slot.inode = info.st_ino;
        slot.modified = info.st_mtimespec;
        ADPointerImageApply(window, pointer);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "a raster decoder exception must restore the arrow");
        NSBitmapImageRep *replacement =
            [[NSBitmapImageRep alloc] initWithData:[NSData dataWithContentsOfFile:small]];
        NSData *tiff = [replacement representationUsingType:NSBitmapImageFileTypeTIFF properties:@{}];
        require(tiff != nil && [[NSImage alloc] initWithData:tiff].isValid,
                "replacement must be a decodable non-PNG image");
        for (NSData *data in @[tiff, [@"%PDF-1.7\ninvalid" dataUsingEncoding:NSUTF8StringEncoding]]) {
            NSString *swapped = writePNG(@"ad-cursor-swapped", 20, 30);
            agent_desktop_cursor_overlay_image(0, swapped.fileSystemRepresentation, 0.0, 0.0);
            ADPointerImageApply(window, pointer);
            require(pointer.hidden, "PNG must be drawn before replacement");
            require([data writeToFile:swapped atomically:YES], "replacement must be written");
            ADPointerImageApply(window, pointer);
            require(!pointer.hidden && ADImageLayer.superlayer == nil,
                    "a non-PNG swapped after validation must restore the arrow");
            [[NSFileManager defaultManager] removeItemAtPath:swapped error:nil];
        }
        NSString *fifo = writePNG(@"ad-cursor-fifo", 20, 30);
        agent_desktop_cursor_overlay_image(0, fifo.fileSystemRepresentation, 0.0, 0.0);
        ADPointerImageApply(window, pointer);
        require(pointer.hidden, "PNG must be drawn before FIFO replacement");
        require([[NSFileManager defaultManager] removeItemAtPath:fifo error:nil],
                "FIFO fixture must replace the image");
        require(mkfifo(fifo.fileSystemRepresentation, 0600) == 0, "FIFO must be created");
        alarm(2);
        ADPointerImageApply(window, pointer);
        alarm(0);
        require(!pointer.hidden && ADImageLayer.superlayer == nil,
                "a FIFO must promptly restore the arrow without waiting for a writer");
        [[NSFileManager defaultManager] removeItemAtPath:fifo error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:bomb error:nil];
        [[NSFileManager defaultManager] removeItemAtPath:small error:nil];
    }
    return 0;
}
