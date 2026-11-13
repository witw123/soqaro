import { UnauthorizedException } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";

describe("MetricsController", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it("enforces METRICS_TOKEN even outside production when configured", () => {
    process.env.NODE_ENV = "development";
    process.env.METRICS_TOKEN = "metrics-secret-token";
    const controller = new MetricsController(
      { renderPrometheus: jest.fn(() => "ok 1\n") } as never,
      { isAvailable: jest.fn(() => true) } as never,
      { isAvailable: jest.fn(() => true) } as never
    );

    expect(() => controller.getMetrics(undefined)).toThrow(UnauthorizedException);
    expect(() => controller.getMetrics("Bearer wrong-token-value")).toThrow(UnauthorizedException);
    expect(controller.getMetrics("Bearer metrics-secret-token")).toBe("ok 1\n");
  });

  it("rejects production requests when METRICS_TOKEN is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.METRICS_TOKEN;
    const controller = new MetricsController(
      { renderPrometheus: jest.fn(() => "ok 1\n") } as never,
      { isAvailable: jest.fn(() => true) } as never,
      { isAvailable: jest.fn(() => true) } as never
    );

    expect(() => controller.getMetrics("Bearer anything")).toThrow(UnauthorizedException);
  });
});
