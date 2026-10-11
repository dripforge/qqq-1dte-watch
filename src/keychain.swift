import Foundation
import Security

let service = "org.qqq-1dte-watch.oauth"
let account = "robinhood"
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

guard CommandLine.arguments.count == 2 else { exit(64) }
let action = CommandLine.arguments[1]
if action == "get" {
    var item: CFTypeRef?
    var getQuery = query
    getQuery[kSecReturnData as String] = true
    getQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(getQuery as CFDictionary, &item)
    if status == errSecItemNotFound { exit(2) }
    guard status == errSecSuccess, let data = item as? Data else { exit(1) }
    FileHandle.standardOutput.write(data)
} else if action == "put" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { exit(64) }
    let update: [String: Any] = [kSecValueData as String: data]
    var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else { exit(1) }
} else { exit(64) }
