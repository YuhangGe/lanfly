// Raw Caps presses and configured input-source shortcuts. Never seize devices or
// alter keyboard preferences. The manager lives on the native capture run loop.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/hid/IOHIDManager.h>
#include <unistd.h>

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
      // System hotkeys require real modifier transitions, not just Control on
      // a Space event. Restore previously held modifiers after the shortcut.
      CGEventFlags flags = [parameters[2] unsignedLongLongValue] & 0x001e0000;
      CGEventFlags saved = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
      const CGKeyCode keys[] = {56, 59, 58, 55};
      const CGEventFlags masks[] = {kCGEventFlagMaskShift, kCGEventFlagMaskControl,
                                   kCGEventFlagMaskAlternate, kCGEventFlagMaskCommand};
      CGEventRef events[10] = {0};
      size_t count = 0;
      CGEventFlags current = flags & saved;
      for (size_t i = 0; i < 4; i++) {
        if (!(flags & masks[i]) || (saved & masks[i])) continue;
        current |= masks[i];
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, keys[i], true);
        events[count++] = event;
        if (event) {
          CGEventSetType(event, kCGEventFlagsChanged);
          CGEventSetFlags(event, current);
        }
      }
      CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key, true);
      CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)key, false);
      events[count++] = down;
      events[count++] = up;
      if (down) CGEventSetFlags(down, flags);
      if (up) CGEventSetFlags(up, flags);
      for (size_t i = 4; i-- > 0;) {
        if (!(flags & masks[i]) || (saved & masks[i])) continue;
        current &= ~masks[i];
        CGEventRef event = CGEventCreateKeyboardEvent(NULL, keys[i], false);
        events[count++] = event;
        if (event) {
          CGEventSetType(event, kCGEventFlagsChanged);
          CGEventSetFlags(event, current | saved);
        }
      }
      // Also restore flags for a modifier-free shortcut or already-held chord.
      if (events[count - 1]) CGEventSetFlags(events[count - 1], saved);
      bool allocated = true;
      for (size_t i = 0; i < count; i++) allocated = allocated && events[i] != NULL;
      if (allocated) {
        for (size_t i = 0; i < count; i++) {
          CGEventSetIntegerValueField(events[i], kCGEventSourceUserData, tag);
          CGEventPost(kCGHIDEventTap, events[i]);
          if (events[i] == down) usleep(20000);
        }
      }
      for (size_t i = 0; i < count; i++) if (events[i]) CFRelease(events[i]);
      if (!allocated) return -1;
      return 1;
    }
    return 0;
  }
}
