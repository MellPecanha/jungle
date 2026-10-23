import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/** Extension point for future OIDC provider identity verification. No authentication is performed. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
