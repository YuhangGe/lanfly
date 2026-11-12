// Raw Caps presses and configured input-source shortcuts. Never seize devices or
// alter keyboard preferences. The manager lives on the native capture run loop.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/hid/IOHIDManager.h>

static IOHIDManagerRef manager;
static NSMutableSet<NSValue *> *pressedDevices;
static void (*capsPressed)(void);

static void inputValue(void *context, IOReturn result, void *sender, IOHIDValueRef value) {
  (void)context;
  (void)sender;
  if (result != kIOReturnSuccess) return;
  @autoreleasepool {
    IOHIDElementRef element = IOHIDValueGetElement(value);
    if (IOHIDElementGetUsagePage(element) != kHIDPage_KeyboardOrKeypad ||
        IOHIDElementGetUsage(element) != kHIDUsage_KeyboardCapsLock) return;
    NSValue *device = [NSValue valueWithPointer:IOHIDElementGetDevice(element)];
    if (IOHIDValueGetIntegerValue(value)) {
      if (![pressedDevices containsObject:device]) {
        [pressedDevices addObject:device];
        capsPressed();
      }
    } else {
      [pressedDevices removeObject:device];
    }
  }
}

static void removed(void *context, IOReturn result, void *sender, IOHIDDeviceRef device) {
  (void)context;
  (void)result;
  (void)sender;
  @autoreleasepool {
    [pressedDevices removeObject:[NSValue valueWithPointer:device]];
  }
}

bool lanfly_caps_monitor_start(void (*callback)(void)) {
  @autoreleasepool {
    if (manager) return true;
    IOHIDManagerRef candidate = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    if (!candidate) return false;
    NSDictionary *matching = @{
      @kIOHIDDeviceUsagePageKey: @(kHIDPage_GenericDesktop),
      @kIOHIDDeviceUsageKey: @(kHIDUsage_GD_Keyboard),
    };
    IOHIDManagerSetDeviceMatching(candidate, (__bridge CFDictionaryRef)matching);
    IOReturn result = IOHIDManagerOpen(candidate, kIOHIDOptionsTypeNone);
    CFSetRef devices = IOHIDManagerCopyDevices(candidate);
    bool available = result == kIOReturnSuccess && devices && CFSetGetCount(devices) > 0;
    if (devices) CFRelease(devices);
    if (!available) {
      IOHIDManagerClose(candidate, kIOHIDOptionsTypeNone);
      CFRelease(candidate);
      return false;
    }
    capsPressed = callback;
    pressedDevices = [NSMutableSet set];
    IOHIDManagerRegisterInputValueCallback(candidate, inputValue, NULL);
    IOHIDManagerRegisterDeviceRemovalCallback(candidate, removed, NULL);
    IOHIDManagerScheduleWithRunLoop(candidate, CFRunLoopGetCurrent(), kCFRunLoopDefaultMode);
    manager = candidate;
    return true;
  }
}

// 1: submitted, 0: no enabled standard input-source shortcut, -1: allocation failed.
// Caller observes the actual source change; submission is not proof of switching.
int lanfly_input_source_shortcut(int64_t tag) {
  @autoreleasepool {
    NSDictionary *hotkeys = CFBridgingRelease(CFPreferencesCopyAppValue(
        CFSTR("AppleSymbolicHotKeys"), CFSTR("com.apple.symbolichotkeys")));
    if (![hotkeys isKindOfClass:NSDictionary.class]) return 0;
    for (NSString *identifier in @[@"60", @"61"]) {
      NSDictionary *entry = hotkeys[identifier];
      if (![entry isKindOfClass:NSDictionary.class] || ![entry[@"enabled"] boolValue]) continue;
      NSDictionary *value = entry[@"value"];
      if (![value isKindOfClass:NSDictionary.class] || ![value[@"type"] isEqual:@"standard"]) continue;
      NSArray *parameters = value[@"parameters"];
      if (![parameters isKindOfClass:NSArray.class] || parameters.count != 3 ||
          ![parameters[1] isKindOfClass:NSNumber.class] ||
          ![parameters[2] isKindOfClass:NSNumber.class]) continue;
      NSInteger key = [parameters[1] integerValue];
      if (key < 0 || key > 127) continue;
      CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key, true);
      CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key, false);
      if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        return -1;
      }
      CGEventFlags flags = [parameters[2] unsignedLongLongValue] & 0x00ff0000;
      CGEventSetFlags(down, flags);
      CGEventSetFlags(up, CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState));
      CGEventSetIntegerValueField(down, kCGEventSourceUserData, tag);
      CGEventSetIntegerValueField(up, kCGEventSourceUserData, tag);
      CGEventPost(kCGHIDEventTap, down);
      CGEventPost(kCGHIDEventTap, up);
      CFRelease(down);
      CFRelease(up);
      return 1;
    }
    return 0;
  }
}
