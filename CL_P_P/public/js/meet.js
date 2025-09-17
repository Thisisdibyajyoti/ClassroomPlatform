let socketRef;
let classroomRef;
let userRef;
let localStream;
const peers = {}; // socketId -> RTCPeerConnection

function createPC(to){
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  pc.onicecandidate = (e)=>{
    if(e.candidate) socketRef.emit("ice-candidate", { roomId: classroomRef, to, candidate: e.candidate });
  };
  pc.ontrack = (e)=>{
    const vid = document.createElement('video');
    vid.autoplay = true; vid.playsInline = true;
    vid.srcObject = e.streams[0];
    document.getElementById('remoteVideos').appendChild(vid);
    pc._remoteVideo = vid;
  };
  return pc;
}

async function initMeet(socket, classroomId, user){
  socketRef = socket; classroomRef = classroomId; userRef = user;
  // Presence for participants label
  socket.on('room-users', (users)=>{
    document.getElementById('participants').textContent = users.map(u=>u.name+' ('+u.role+')').join(', ');
  });

  // Chat relay
  socket.on('chat', (msg)=>{}); // handled in classroom.html

  // WebRTC signaling
  socket.on('offer', async ({ from, offer })=>{
    const pc = createPC(from);
    peers[from] = pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    socket.emit('answer', { roomId: classroomId, to: from, answer });
  });
  socket.on('answer', async ({ from, answer })=>{
    const pc = peers[from]; if(!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });
  socket.on('ice-candidate', async ({ from, candidate })=>{
    const pc = peers[from]; if(!pc) return;
    try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){}
  });

  socket.on('kicked', ()=>{ alert('You were removed by the teacher'); leaveMeet(); });
  socket.on('meet-ended', ()=>{ alert('Meet ended by teacher'); leaveMeet(); });

  // Buttons
  document.getElementById('joinBtn').onclick = joinMeet;
  document.getElementById('leaveBtn').onclick = leaveMeet;
  document.getElementById('muteBtn').onclick = ()=> setMute(true);
  document.getElementById('unmuteBtn').onclick = ()=> setMute(false);
  document.getElementById('shareBtn')?.addEventListener('click', shareScreen);
}

async function joinMeet(){
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = localStream;
  }catch(e){
    alert('Could not access camera/mic'); return;
  }
  // Announce join (also triggers room users list)
  socketRef.emit('join-room', { roomId: classroomRef, user: userRef });

  // Ask server who else is here by sending a dummy "whoami"
  socketRef.emit('whoami', { roomId: classroomRef });
  socketRef.once('peers', async (peerIds)=>{
    // Create offers to all peers
    for(const pid of peerIds){
      if(pid === socketRef.id) continue;
      const pc = createPC(pid);
      peers[pid] = pc;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.emit('offer', { roomId: classroomRef, to: pid, offer });
    }
  });
}

function setMute(mute){
  if(!localStream) return;
  localStream.getAudioTracks().forEach(t=> t.enabled = !mute);
}

async function shareScreen(){
  try{
    const display = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
    const screenTrack = display.getVideoTracks()[0];
    // Replace video track in each peer
    for(const pc of Object.values(peers)){
      const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
      if(sender) sender.replaceTrack(screenTrack);
    }
    screenTrack.onended = ()=>{
      // revert back to camera if available
      const cam = localStream.getVideoTracks()[0];
      for(const pc of Object.values(peers)){
        const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
        if(sender && cam) sender.replaceTrack(cam);
      }
    };
  }catch(e){ alert('Screen share failed'); }
}

function leaveMeet(){
  socketRef.emit('leave-room', { roomId: classroomRef });
  for(const [id, pc] of Object.entries(peers)){
    try{ pc.close(); }catch(e){}
    if(pc._remoteVideo) pc._remoteVideo.remove();
    delete peers[id];
  }
  if(localStream){
    localStream.getTracks().forEach(t=> t.stop());
    localStream = null;
    document.getElementById('localVideo').srcObject = null;
  }
}