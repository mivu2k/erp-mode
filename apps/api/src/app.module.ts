import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ENGINE_CONTROLLERS } from './engine/engine.controller';
import { HooksService } from './engine/hooks';
import { ResourceService } from './engine/resource.service';
import { WorkflowService } from './engine/workflow.service';
import { AdminController } from './modules/admin';
import { FinanceController } from './modules/finance';
import { FleetGatepassController } from './modules/fleet-gatepass';
import { HrmController } from './modules/hrm';
import { InventoryController } from './modules/inventory';
import { RepairController } from './modules/repair';
import { JobsController, JobsService } from './modules/jobs';
import { ReportsController } from './modules/reports';
import { SerialsController } from './modules/serials';
import { CatalogController } from './modules/catalog';
import { UtilitiesController } from './modules/utilities';
import { AuditService } from './platform/audit.service';
import { LedgerService } from './platform/ledger.service';
import { MailerService } from './platform/mailer.service';
import { PdfService } from './platform/pdf.service';
import { NotifyService } from './platform/notify.service';
import { NumberingService } from './platform/numbering.service';
import { PrintService } from './platform/print.service';
import { PrismaService } from './platform/prisma.service';
import { SearchService } from './platform/search.service';
import { SettingsService } from './platform/settings.service';
import { StockService } from './platform/stock.service';
import { StorageService } from './platform/storage.service';
import { AuthGuard, Public } from './rbac/rbac';

@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}

// Module controllers double as hook registrars, so they are also providers (other modules inject them).
const MODULE_CONTROLLERS = [AdminController, HrmController, FinanceController, InventoryController, RepairController, SerialsController, FleetGatepassController, ReportsController, CatalogController, UtilitiesController];

@Module({
  imports: [
    ThrottlerModule.forRoot([{ limit: 600, ttl: 60_000 }]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: (process.env.ACCESS_TTL ?? '15m') as `${number}m` },
    }),
  ],
  controllers: [HealthController, AuthController, JobsController, ...ENGINE_CONTROLLERS, ...MODULE_CONTROLLERS],
  providers: [
    PrismaService, AuditService, SettingsService, NumberingService, LedgerService, StockService, SearchService, NotifyService, PrintService, StorageService, MailerService, PdfService, JobsService,
    HooksService, ResourceService, WorkflowService, AuthService, AuthGuard,
    ...MODULE_CONTROLLERS,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
})
export class AppModule {}
