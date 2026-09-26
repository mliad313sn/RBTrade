import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { DevIdpService } from './dev-idp.service';
import { OidcBffController } from './oidc-bff.controller';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';
import { UserProvisioner } from './user-provisioner.service';
import { UsersRepository } from './users.repository';

@Module({
  providers: [TokenService, UsersRepository, DevIdpService, UserProvisioner, SessionsService],
  controllers: [AuthController, OidcBffController],
  exports: [TokenService, UsersRepository, UserProvisioner, DevIdpService, SessionsService],
})
export class AuthModule {}
