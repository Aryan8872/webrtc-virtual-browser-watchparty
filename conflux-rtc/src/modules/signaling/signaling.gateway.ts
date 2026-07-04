import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import { SignalingService } from './signaling.service';
import { Server, Socket } from 'socket.io';

// tells NestJS to bootstrap a Socket.io WebSocket server under the hood
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class SignalingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  // injects the raw Socket.io Server instance so we can perform broadcasts if necessary.
  @WebSocketServer()
  server: Server;
  constructor(private readonly signalingService: SignalingService) {}
  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    // Listen for the "disconnecting" hook right before the client leaves their rooms
    client.on('disconnecting', () => {
      // Loop through all rooms this client joined (except their own private socket.id room)
      client.rooms.forEach((room) => {
        if (room !== client.id) {
          console.log(
            `Notifying room ${room} that client ${client.id} is leaving`,
          );
          client.to(room).emit('user-left', { userId: client.id });
        }
      });
    });
  }
  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId } = data;
    client.join(roomId);
    console.log(`Client joined room: ${roomId}`);
    // Notify other peers in the room that a new user has joined
    client.to(roomId).emit('user-joined', { userId: client.id });
  }

  @SubscribeMessage('sdp-offer')
  handleSdpOffer(
    @MessageBody() data: { roomId: string; sdp: any },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, sdp } = data;
    console.log(`SDP Offer received from ${client.id} for room ${roomId}`);
    // Forward the SDP Offer along with the sender's ID to everyone else in the room
    client.to(roomId).emit('sdp-offer', { senderId: client.id, sdp });
  }

  @SubscribeMessage('sdp-answer')
  handleSdpAnswer(
    @MessageBody() data: { roomId: string; sdp: any },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, sdp } = data;
    console.log(`SDP Answer received from ${client.id} for room ${roomId}`);
    // Forward the SDP Answer along with the sender's ID to everyone else in the room
    client.to(roomId).emit('sdp-answer', { senderId: client.id, sdp });
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    @MessageBody() data: { roomId: string; iceCandidate: '' },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, iceCandidate } = data;
    client
      .to(roomId)
      .emit('ice-candidate', { senderId: client.id, iceCandidate });
  }

  @SubscribeMessage('page-frame')
  handlePageFrameStream(
    @MessageBody() data: { roomId: string; frame: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, frame } = data;
    client.to(roomId).emit('page-frame', { frame });
  }

  @SubscribeMessage('canvas-click')
  handleCanvasClick(
    @MessageBody() data: { roomId: string; x: number; y: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, x, y } = data;
    console.log(
      `[Backend] Relay canvas-click for room ${roomId} to x:${x}, y:${y}`,
    );
    client.to(roomId).emit('canvas-click', { x, y });
  }

  @SubscribeMessage('canvas-keydown')
  handleCanvasKeydown(
    @MessageBody() data: { roomId: string; key: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { roomId, key } = data;
    console.log(`[Backend] Relay keydown for room ${roomId}: ${key}`);
    client.to(roomId).emit('canvas-keydown', { key });
  }
}
