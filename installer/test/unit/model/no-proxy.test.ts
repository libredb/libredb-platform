import { describe, expect, test } from "bun:test";
import { noProxyHosts, renderNoProxy } from "../../../src/model/no-proxy";

const hosts = { platform: "platform.example.com", studio: "studio.example.com", auth: "auth.example.com" };

describe("NO_PROXY", () => {
  test("NO_PROXY lists every endpoint host, the PostgreSQL host, .svc, .cluster.local, localhost and 127.0.0.1", () => {
    expect(renderNoProxy(hosts, "postgres")).toBe(
      "platform.example.com,studio.example.com,auth.example.com,postgres,.svc,.cluster.local,localhost,127.0.0.1",
    );
  });

  test("lists each host once", () => {
    expect(noProxyHosts(hosts, "localhost")).toEqual([
      "platform.example.com",
      "studio.example.com",
      "auth.example.com",
      "localhost",
      ".svc",
      ".cluster.local",
      "127.0.0.1",
    ]);
  });
});
