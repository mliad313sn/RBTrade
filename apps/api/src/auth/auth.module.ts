import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { DevIdpService } from './dev-idp.service';
import { OidcBffController } from './oidc-bff.controller';
import { TokenService } from './token.service';
import { UserProvisioner } from './user-provisioner.service';
import { UsersRepository } from './users.repository';

@Module({
  providers: [TokenService, UsersRepository, DevIdpService, UserProvisioner],
  controllers: [AuthController, OidcBffController],
  exports: [TokenService, UsersRepository, UserProvisioner],
})
export class AuthModule {}
