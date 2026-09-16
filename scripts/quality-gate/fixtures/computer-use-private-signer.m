#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <arpa/inet.h>

// Apple's codesign command filters identity discovery through system trust.
// This fixture passes its single private-keychain identity directly to the
// same signing API. It never changes trust settings. Resulting signatures must
// still pass the unchanged production strict checks and peer attestation.
typedef struct __SecCodeSigner *SecCodeSignerRef;
extern const CFStringRef kSecCodeSignerIdentity;
extern const CFStringRef kSecCodeSignerIdentifier;
extern const CFStringRef kSecCodeSignerFlags;
extern const CFStringRef kSecCodeSignerRequireTimestamp;
extern const CFStringRef kSecCodeSignerEntitlements;
extern OSStatus SecCodeSignerCreate(CFDictionaryRef, SecCSFlags, SecCodeSignerRef *);
extern OSStatus SecCodeSignerAddSignature(SecCodeSignerRef, SecStaticCodeRef, SecCSFlags);

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 4) return 2;
    SecKeychainSetUserInteractionAllowed(false);
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(argv[1], &keychain);
    if (status) { fprintf(stderr, "private keychain open: %d\n", (int)status); return 1; }
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassIdentity,
      (__bridge id)kSecMatchSearchList: @[(__bridge id)keychain],
      (__bridge id)kSecReturnRef: @YES,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
    };
    CFTypeRef identity = NULL;
    status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &identity);
    if (status) { fprintf(stderr, "private identity lookup: %d\n", (int)status); return 1; }
    NSMutableDictionary *parameters = [@{
      (__bridge id)kSecCodeSignerIdentity: (__bridge id)identity,
      (__bridge id)kSecCodeSignerIdentifier: @(argv[3]),
      (__bridge id)kSecCodeSignerFlags: @(kSecCodeSignatureRuntime),
      (__bridge id)kSecCodeSignerRequireTimestamp: @NO,
    } mutableCopy];
    if (argc > 4) {
      NSData *plist = [NSData dataWithContentsOfFile:@(argv[4])];
      // SecCodeSigner consumes the code-signing entitlement blob, not the
      // bare XML accepted by the codesign command-line frontend.
      uint32_t header[] = { htonl(0xfade7171), htonl((uint32_t)plist.length + 8) };
      NSMutableData *blob = [NSMutableData dataWithBytes:header length:8];
      [blob appendData:plist];
      parameters[(__bridge id)kSecCodeSignerEntitlements] = blob;
    }
    SecCodeSignerRef signer = NULL;
    status = SecCodeSignerCreate((__bridge CFDictionaryRef)parameters, 0, &signer);
    if (status) { fprintf(stderr, "signer create: %d\n", (int)status); return 1; }
    SecStaticCodeRef code = NULL;
    status = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[2])], 0, &code);
    if (!status) status = SecCodeSignerAddSignature(signer, code, 0);
    if (status) fprintf(stderr, "private signing: %d\n", (int)status);
    if (code) CFRelease(code);
    CFRelease(signer);
    CFRelease(identity);
    CFRelease(keychain);
    return status == 0 ? 0 : 1;
  }
}
