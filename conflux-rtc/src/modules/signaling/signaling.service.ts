import { Injectable } from '@nestjs/common';

@Injectable()
export class SignalingService {
  findAll() {
    return `This action returns all signaling`;
  }

  findOne(id: number) {
    return `This action returns a #${id} signaling`;
  }

  remove(id: number) {
    return `This action removes a #${id} signaling`;
  }
}
