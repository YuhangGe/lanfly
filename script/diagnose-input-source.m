// Standalone macOS probe. Build/run instructions and interpretation are in BUG.md.
// All TIS calls stay on this process's main thread; ordinary typed keys are not logged.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#include <stddef.h>
#include <unistd.h>

static BOOL suppressCaps;
static double started;
static NSString *lastSource;
static BOOL lastSecure;

static void emit(NSString *kind, NSDictionary *fields) {
  NSMutableDictionary *record = [fields mutableCopy];
  record[@"kind"] = kind;
  record[@"ms"] = @((CFAbsoluteTimeGetCurrent() - started) * 1000);
  NSData *data = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:NULL];
  puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
  fflush(stdout);
}

static id property(TISInputSourceRef source, CFStringRef key) {
  return source ? (__bridge id)TISGetInputSourceProperty(source, key) : nil;
}

static NSDictionary *describe(TISInputSourceRef source) {
  return @{
    @"id": property(source, kTISPropertyInputSourceID) ?: @"",
    @"mode": property(source, kTISPropertyInputModeID) ?: @"",
    @"type": property(source, kTISPropertyInputSourceType) ?: @"",
    @"enabled": property(source, kTISPropertyInputSourceIsEnabled) ?: @NO,
    @"selectable": property(source, kTISPropertyInputSourceIsSelectCapable) ?: @NO,
    @"ascii": property(source, kTISPropertyInputSourceIsASCIICapable) ?: @NO,
  };
}

static void sample(BOOL force) {
  TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
  NSDictionary *info = describe(source);
  NSString *identity = [NSString stringWithFormat:@"%@/%@", info[@"id"], info[@"mode"]];
  BOOL secure = IsSecureEventInputEnabled();
  if (force || ![identity isEqualToString:lastSource] || secure != lastSecure) {
    emit(@"source", @{@"current": info, @"secureInput": @(secure)});
  }
  lastSource = identity;
  lastSecure = secure;
  if (source) CFRelease(source);
}

static void pump(double seconds) {
  double until = CFAbsoluteTimeGetCurrent() + seconds;
  do {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
    sample(NO);
    // Avoid spinning if there are no run-loop sources.
    usleep(10000);
  } while (CFAbsoluteTimeGetCurrent() < until);
}

static CGEventRef tapped(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
  (void)proxy;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    emit(@"tap-disabled", @{@"tap": (__bridge NSString *)context, @"type": @(type)});
    return event;
  }
  CGKeyCode key = (CGKeyCode)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if (key != 57 && key != 255) return event;
  CGEventFlags flags = CGEventGetFlags(event);
  BOOL swallowed = suppressCaps && [(__bridge NSString *)context isEqualToString:@"hid"];
  emit(@"event", @{
    @"tap": (__bridge NSString *)context, @"type": @(type), @"key": @(key),
    @"flags": [NSString stringWithFormat:@"0x%llx", (unsigned long long)flags],
    @"timestamp": @(CGEventGetTimestamp(event)), @"swallowed": @(swallowed),
    @"pid": @(CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID)),
    @"tag": @(CGEventGetIntegerValueField(event, kCGEventSourceUserData)),
  });
  return swallowed ? NULL : event;
}

static CFMachPortRef installTap(CGEventTapLocation location, NSString *name, BOOL active) {
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                     CGEventMaskBit(kCGEventFlagsChanged);
  CFMachPortRef tap = CGEventTapCreate(location, kCGHeadInsertEventTap,
      active ? kCGEventTapOptionDefault : kCGEventTapOptionListenOnly,
      mask, tapped, (__bridge void *)name);
  emit(@"tap", @{@"tap": name, @"created": @(tap != NULL), @"active": @(active)});
  if (tap) {
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
    CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopDefaultMode);
    CFRelease(source);
  }
  return tap;
}

static BOOL postHID(NSString *mode) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"));
  io_connect_t driver = 0;
  kern_return_t opened = service ? IOServiceOpen(service, mach_task_self(), kIOHIDParamConnectType, &driver) : KERN_FAILURE;
  if (service) IOObjectRelease(service);
  emit(@"hid-open", @{@"result": @(opened)});
  if (opened != KERN_SUCCESS) return NO;
  BOOL keys = [mode isEqualToString:@"hid-key"];
  UInt32 downFlags = [mode isEqualToString:@"hid-stateless"]
      ? NX_ALPHASHIFT_STATELESS_MASK | NX_DEVICE_ALPHASHIFT_STATELESS_MASK : NX_ALPHASHIFTMASK;
  BOOL ok = YES;
  for (int i = 0; i < 2; i++) {
    NXEventData data = {0};
    data.key.keyCode = 57;
    UInt32 type = keys ? (i == 0 ? NX_KEYDOWN : NX_KEYUP) : NX_FLAGSCHANGED;
    UInt32 flags = keys ? 0 : (i == 0 ? downFlags : 0);
    kern_return_t result = IOHIDPostEvent(driver, type, (IOGPoint){0, 0}, &data,
        kNXEventDataVersion, flags, keys ? 0 : kIOHIDSetGlobalEventFlags);
    emit(@"hid-post", @{@"type": @(type), @"flags": @(flags), @"result": @(result)});
    ok = ok && result == KERN_SUCCESS;
    // hid-alpha deliberately reproduces production's immediate pair.
    if (i == 0 && ![mode isEqualToString:@"hid-alpha"]) pump(0.08);
  }
  IOServiceClose(driver);
  return ok;
}

static void usage(void) {
  fprintf(stderr, "Usage: diagnose-input-source status | watch | suppress | hid-alpha | hid-stateless | hid-key | shortcut | tis SOURCE_ID\n"
      "status: read-only; watch: listen-only for 30s; suppress: swallow Caps/255 at HID tap for 30s.\n"
      "Injection/TIS modes wait 3s for focus, then observe for 1s. shortcut sends Control-Space (verify your binding).\n");
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    started = CFAbsoluteTimeGetCurrent();
    NSString *mode = argc > 1 ? @(argv[1]) : @"status";
    NSArray *modes = @[@"status", @"watch", @"suppress", @"hid-alpha", @"hid-stateless", @"hid-key", @"shortcut", @"tis"];
    if (![modes containsObject:mode] || ([mode isEqualToString:@"tis"] ? argc != 3 : argc > 2)) {
      usage();
      return 2;
    }
    emit(@"status", @{
      @"os": NSProcessInfo.processInfo.operatingSystemVersionString,
      @"accessibility": @(AXIsProcessTrusted()), @"listening": @(CGPreflightListenEventAccess()),
      @"posting": @(CGPreflightPostEventAccess()), @"uid": @(getuid()),
      @"nxSize": @(sizeof(NXEventData)), @"keyCodeOffset": @(offsetof(NXEventData, key.keyCode)),
    });
    CFArrayRef sources = TISCreateInputSourceList(NULL, false);
    NSMutableArray *enabled = [NSMutableArray array];
    for (CFIndex i = 0; sources && i < CFArrayGetCount(sources); i++) {
      TISInputSourceRef source = (TISInputSourceRef)CFArrayGetValueAtIndex(sources, i);
      if ([property(source, kTISPropertyInputSourceCategory) isEqual:(__bridge id)kTISCategoryKeyboardInputSource]) {
        [enabled addObject:describe(source)];
      }
    }
    emit(@"sources", @{@"list": enabled});
    sample(YES);
    int exitCode = 0;
    if ([mode isEqualToString:@"watch"] || [mode isEqualToString:@"suppress"]) {
      suppressCaps = [mode isEqualToString:@"suppress"];
      CFMachPortRef hid = installTap(kCGHIDEventTap, @"hid", suppressCaps);
      CFMachPortRef session = installTap(kCGSessionEventTap, @"session", NO);
      if (hid && session) pump(30);
      else exitCode = 1;
      if (hid) { CFMachPortInvalidate(hid); CFRelease(hid); }
      if (session) { CFMachPortInvalidate(session); CFRelease(session); }
    } else if (![mode isEqualToString:@"status"]) {
      emit(@"countdown", @{@"seconds": @3, @"mode": mode});
      pump(3);
      sample(YES);
      if ([mode hasPrefix:@"hid-"]) {
        if (!postHID(mode)) exitCode = 1;
      } else if ([mode isEqualToString:@"shortcut"]) {
        // Explicit flags prevent inheriting unrelated physical modifiers.
        for (int i = 0; i < 2; i++) {
          CGEventRef event = CGEventCreateKeyboardEvent(NULL, 49, i == 0);
          if (!event) { exitCode = 1; break; }
          CGEventSetFlags(event, kCGEventFlagMaskControl);
          CGEventPost(kCGHIDEventTap, event);
          CFRelease(event);
          if (i == 0) pump(0.08);
        }
        emit(@"shortcut-post", @{@"allocated": @(exitCode == 0), @"key": @49, @"flags": @(kCGEventFlagMaskControl)});
      } else {
        BOOL found = NO;
        for (CFIndex i = 0; sources && i < CFArrayGetCount(sources); i++) {
          TISInputSourceRef source = (TISInputSourceRef)CFArrayGetValueAtIndex(sources, i);
          if (![property(source, kTISPropertyInputSourceID) isEqual:@(argv[2])]) continue;
          OSStatus result = TISSelectInputSource(source);
          emit(@"tis-select", @{@"target": describe(source), @"result": @(result)});
          found = YES;
          if (result != noErr) exitCode = 1;
          break;
        }
        if (!found) { emit(@"error", @{@"message": @"Source ID not found"}); exitCode = 1; }
      }
      pump(1);
      sample(YES);
    }
    if (sources) CFRelease(sources);
    return exitCode;
  }
}
