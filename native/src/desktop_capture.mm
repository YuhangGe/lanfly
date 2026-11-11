// ScreenCaptureKit bridge for the Rust DesktopCapture module.
//
// The screen output callback delivers a retained CVPixelBuffer straight to Rust. No image
// bytes are copied here and no frame is ever routed through JavaScript.
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>

typedef void (*LFFrameCallback)(void *ctx, CVPixelBufferRef buffer, int64_t pts_value, int32_t pts_timescale);
typedef void (*LFErrorCallback)(void *ctx, const char *message);

static void lf_set_error(char *buffer, size_t length, NSString *message) {
    if (!buffer || length == 0) return;
    const char *text = message.UTF8String;
    if (!text) text = "DESKTOP_CAPTURE_FAILED";
    snprintf(buffer, length, "%s", text);
}

static uint32_t lf_even(uint32_t value) {
    return value < 2 ? 2 : value & ~1u;
}

@class LFCaptureImpl;

@interface LFCaptureOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, assign) void *ctx;
@property(nonatomic, assign) LFFrameCallback onFrame;
@property(nonatomic, assign) LFErrorCallback onError;
@property(nonatomic, assign) BOOL stopped;
@property(nonatomic, assign) BOOL reported;
@property(nonatomic, assign) uint32_t configuredWidth;
@property(nonatomic, assign) uint32_t configuredHeight;
- (void)reportError:(NSString *)message;
@end

@implementation LFCaptureOutput

- (void)reportError:(NSString *)message {
    if (self.reported || self.stopped) return;
    self.reported = YES;
    if (self.onError) self.onError(self.ctx, message.UTF8String);
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (self.stopped || type != SCStreamOutputTypeScreen) return;
    if (!sampleBuffer || !CMSampleBufferIsValid(sampleBuffer)) return;
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer) return;
    const size_t width = CVPixelBufferGetWidth(pixelBuffer);
    const size_t height = CVPixelBufferGetHeight(pixelBuffer);
    if (width != self.configuredWidth || height != self.configuredHeight) {
        [self reportError:@"DESKTOP_DISPLAY_CHANGED"];
        return;
    }
    CVPixelBufferRetain(pixelBuffer);
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    self.onFrame(self.ctx, pixelBuffer, pts.value, pts.timescale);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (!self.stopped) {
        [self reportError:error.localizedDescription ?: @"DESKTOP_CAPTURE_FAILED"];
    }
}

@end

@interface LFCaptureImpl : NSObject
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) LFCaptureOutput *output;
@property(nonatomic, assign) BOOL stopped;
- (void)stop;
@end

@implementation LFCaptureImpl

- (void)stop {
    if (self.stopped) return;
    self.stopped = YES;
    self.output.stopped = YES;
    SCStream *stream = self.stream;
    self.stream = nil;
    if (!stream) return;
    // Detach the sample output first so no new frame is delivered while the stream stops.
    if (self.output) {
        NSError *removeError = nil;
        [stream removeStreamOutput:self.output type:SCStreamOutputTypeScreen error:&removeError];
    }
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        dispatch_semaphore_signal(semaphore);
    }];
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
}

@end

extern "C" void *lf_capture_start(uint32_t max_width,
                                  uint32_t max_height,
                                  uint32_t fps,
                                  LFFrameCallback on_frame,
                                  LFErrorCallback on_error,
                                  void *ctx,
                                  char *error_buffer,
                                  size_t error_length,
                                  uint32_t *out_width,
                                  uint32_t *out_height) {
    @autoreleasepool {
        if (@available(macOS 12.3, *)) {
            if (max_width < 2 || max_height < 2 || fps < 1 || fps > 60) {
                lf_set_error(error_buffer, error_length, @"DESKTOP_INVALID_CONFIG");
                return NULL;
            }

            __block SCShareableContent *content = nil;
            __block NSError *contentError = nil;
            dispatch_semaphore_t contentSemaphore = dispatch_semaphore_create(0);
            [SCShareableContent
                getShareableContentExcludingDesktopWindows:NO
                                             onScreenWindowsOnly:YES
                                              completionHandler:^(SCShareableContent *value,
                                                                  NSError *error) {
                                                  content = value;
                                                  contentError = error;
                                                  dispatch_semaphore_signal(contentSemaphore);
                                              }];
            if (dispatch_semaphore_wait(contentSemaphore,
                                        dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
                lf_set_error(error_buffer, error_length, @"DESKTOP_CAPTURE_TIMEOUT");
                return NULL;
            }
            if (contentError || !content || content.displays.count == 0) {
                lf_set_error(error_buffer, error_length,
                             contentError.localizedDescription ?: @"DESKTOP_PERMISSION");
                return NULL;
            }

            const CGDirectDisplayID mainDisplay = CGMainDisplayID();
            SCDisplay *display = nil;
            for (SCDisplay *candidate in content.displays) {
                if (candidate.displayID == mainDisplay) {
                    display = candidate;
                    break;
                }
            }
            if (!display) display = content.displays.firstObject;
            const uint32_t pixelWidth = (uint32_t)display.width;
            const uint32_t pixelHeight = (uint32_t)display.height;
            if (pixelWidth < 2 || pixelHeight < 2) {
                lf_set_error(error_buffer, error_length, @"DESKTOP_NO_DISPLAY");
                return NULL;
            }
            const double scale = MIN(1.0, MIN((double)max_width / (double)pixelWidth,
                                              (double)max_height / (double)pixelHeight));
            const uint32_t width = lf_even((uint32_t)llround((double)pixelWidth * scale));
            const uint32_t height = lf_even((uint32_t)llround((double)pixelHeight * scale));

            SCContentFilter *filter =
                [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
            configuration.width = width;
            configuration.height = height;
            configuration.minimumFrameInterval = CMTimeMake(1, (int32_t)fps);
            configuration.pixelFormat = kCVPixelFormatType_32BGRA;
            configuration.queueDepth = 3;
            // The controller renders its own local pointer over the video. Capturing the
            // host cursor as well makes it lag behind the local pointer and look like a
            // second animated cursor chasing it.
            configuration.showsCursor = NO;
            configuration.scalesToFit = YES;

            LFCaptureOutput *output = [[LFCaptureOutput alloc] init];
            output.ctx = ctx;
            output.onFrame = on_frame;
            output.onError = on_error;
            output.stopped = NO;
            output.reported = NO;
            output.configuredWidth = width;
            output.configuredHeight = height;

            dispatch_queue_t queue =
                dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0);
            SCStream *stream = [[SCStream alloc] initWithFilter:filter
                                                  configuration:configuration
                                                       delegate:output];
            NSError *outputError = nil;
            if (![stream addStreamOutput:output
                                    type:SCStreamOutputTypeScreen
                      sampleHandlerQueue:queue
                                   error:&outputError]) {
                lf_set_error(error_buffer, error_length,
                             outputError.localizedDescription ?: @"DESKTOP_CAPTURE_FAILED");
                return NULL;
            }

            __block NSError *startError = nil;
            dispatch_semaphore_t startSemaphore = dispatch_semaphore_create(0);
            [stream startCaptureWithCompletionHandler:^(NSError *value) {
                startError = value;
                dispatch_semaphore_signal(startSemaphore);
            }];
            if (dispatch_semaphore_wait(startSemaphore,
                                        dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
                if (output) {
                    NSError *removeError = nil;
                    [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:&removeError];
                }
                [stream stopCaptureWithCompletionHandler:nil];
                lf_set_error(error_buffer, error_length, @"DESKTOP_CAPTURE_TIMEOUT");
                return NULL;
            }
            if (startError) {
                if (output) {
                    NSError *removeError = nil;
                    [stream removeStreamOutput:output type:SCStreamOutputTypeScreen error:&removeError];
                }
                lf_set_error(error_buffer, error_length,
                             startError.localizedDescription ?: @"DESKTOP_PERMISSION");
                return NULL;
            }

            LFCaptureImpl *capture = [[LFCaptureImpl alloc] init];
            capture.stream = stream;
            capture.output = output;
            capture.stopped = NO;
            if (out_width) *out_width = width;
            if (out_height) *out_height = height;
            return (__bridge_retained void *)capture;
        }

        lf_set_error(error_buffer, error_length, @"DESKTOP_UNSUPPORTED");
        return NULL;
    }
}

extern "C" void lf_capture_stop(void *handle) {
    if (!handle) return;
    @autoreleasepool {
        LFCaptureImpl *capture = (__bridge_transfer LFCaptureImpl *)handle;
        [capture stop];
        capture = nil;
    }
}
