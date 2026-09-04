import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { renderMetrics } from "../observability/metrics";

@Controller()
export class MetricsController {
  @Public()
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    const body = await renderMetrics();
    res.type("text/plain; version=0.0.4; charset=utf-8");
    return body;
  }
}
