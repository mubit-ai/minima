import { describe, expect, test } from "bun:test";
import { NetGuardError, assertPublicUrl, blockedIpReason } from "../src/tools/_net_guard.ts";

describe("blockedIpReason", () => {
  const cases: [string, string | null][] = [
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", null],
    ["172.15.0.1", null],
    ["192.168.0.10", "private"],
    ["192.169.0.10", null],
    ["169.254.169.254", "link-local"],
    ["169.253.0.1", null],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["8.8.8.8", null],
    ["203.0.113.9", null],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", null],
    ["fc00::1", "private"],
    ["fd12:3456:789a::1", "private"],
    ["fe00::1", null],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:192.168.1.1", "private"],
    ["::ffff:8.8.8.8", null],
    ["2607:f8b0::1", null],
    ["not-an-ip", null],
    ["example.com", null],
  ];
  for (const [addr, want] of cases) {
    test(`${addr} -> ${want}`, () => {
      expect(blockedIpReason(addr)).toBe(want);
    });
  }
});

describe("assertPublicUrl", () => {
  test("rejects non-http(s) schemes regardless of target", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://203.0.113.9/",
      "gopher://203.0.113.9/",
      "javascript:alert(1)",
      "ws://203.0.113.9/",
    ]) {
      await expect(assertPublicUrl(url, false)).rejects.toThrow(NetGuardError);
      await expect(assertPublicUrl(url, true)).rejects.toThrow(/scheme/);
    }
  });

  test("rejects malformed URLs", async () => {
    await expect(assertPublicUrl("not a url", false)).rejects.toThrow(/invalid URL/);
  });

  test("accepts public literals without resolving", async () => {
    let resolved = 0;
    await assertPublicUrl("https://203.0.113.9/x", false, async () => {
      resolved++;
      return [];
    });
    expect(resolved).toBe(0);
  });

  test("rejects blocked literals", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/", false)).rejects.toThrow(
      /link-local/,
    );
    await expect(assertPublicUrl("http://[::1]/", false)).rejects.toThrow(/loopback/);
  });

  test("checks every resolved address for hostnames", async () => {
    await expect(
      assertPublicUrl("http://internal.corp/", false, async () => ["10.0.0.5"]),
    ).rejects.toThrow(/private/);
    await expect(
      assertPublicUrl("http://rebind.host/", false, async () => [
        "93.184.216.34",
        "192.168.0.7",
      ]),
    ).rejects.toThrow(/private/);
    await assertPublicUrl("http://public.host/", false, async () => [
      "93.184.216.34",
      "2607:f8b0::1",
    ]);
  });

  test("localhost names are loopback by definition (no resolver call)", async () => {
    await expect(assertPublicUrl("http://localhost:8080/", false)).rejects.toThrow(/loopback/);
    await expect(assertPublicUrl("http://api.localhost/", false)).rejects.toThrow(/loopback/);
  });

  test("reserved documentation TLDs fail open without querying DNS", async () => {
    await assertPublicUrl("https://a.example/", false);
    await assertPublicUrl("https://unit.test/", false);
    await assertPublicUrl("https://nope.invalid/", false);
  });

  test("allowLocal lifts the address policy only", async () => {
    await assertPublicUrl("http://127.0.0.1:9/", true);
    await assertPublicUrl("http://[fe80::1]/", true);
    await assertPublicUrl("http://localhost:9/", true);
  });
});
