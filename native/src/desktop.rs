//! Desktop screen sharing: ScreenCaptureKit -> VideoToolbox -> WebRTC (H.264 RTP).
//!
//! Node.js only carries SDP and ICE. Encoded frames never enter JavaScript, and the
//! data channel used for remote control is terminated in Rust on the controlled host.
use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;

use rtc::interceptor::{Interceptor, Registry, Slot};
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_H264, MediaEngine};
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::RTCDtlsRole;
use rtc::peer_connection::transport::RTCIceCandidateInit;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::PayloadType;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters,
    RTCRtpEncodingParameters, RtpCodecKind,
};
use serde::Deserialize;
use serde_json::{Value, json};
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceTransportPolicy,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState,
};
use webrtc::rtp_transceiver::RtpSender;
use webrtc::runtime::Runtime;
use webrtc::runtime::TokioRuntime;

use crate::desktop_capture::{self, Capture, CapturedFrame};
use crate::desktop_encoder::{Encoder, FrameQueue};
use crate::desktop_input;

const MAX_QUEUED_EVENTS: usize = 256;
const H264_PAYLOAD_TYPE: PayloadType = 102;

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct StartConfig {
    max_width: u32,
    max_height: u32,
    fps: u32,
    bitrate: u32,
    local_address: Option<String>,
    control: bool,
}

impl Default for StartConfig {
    fn default() -> Self {
        Self {
            max_width: 3840,
            max_height: 2160,
            fps: 30,
            bitrate: 4_000_000,
            local_address: None,
            control: false,
        }
    }
}

fn push_event(events: &Mutex<VecDeque<Value>>, value: Value) {
    if let Ok(mut queue) = events.lock() {
        if queue.len() >= MAX_QUEUED_EVENTS {
            queue.pop_front();
        }
        queue.push_back(value);
    }
}

fn state_name(state: RTCPeerConnectionState) -> &'static str {
    match state {
        RTCPeerConnectionState::New => "new",
        RTCPeerConnectionState::Connecting => "connecting",
        RTCPeerConnectionState::Connected => "connected",
        RTCPeerConnectionState::Disconnected => "disconnected",
        RTCPeerConnectionState::Failed => "failed",
        RTCPeerConnectionState::Closed => "closed",
        _ => "unknown",
    }
}

struct DesktopHandler {
    events: Arc<Mutex<VecDeque<Value>>>,
    force_keyframe: Arc<AtomicBool>,
    control: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    runtime: Arc<dyn Runtime>,
}

#[async_trait]
impl PeerConnectionEventHandler for DesktopHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(candidate) = event.candidate.to_json()
            && let Ok(value) = serde_json::to_value(candidate)
        {
            push_event(&self.events, json!({"kind": "ice", "candidate": value}));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        push_event(
            &self.events,
            json!({"kind": "state", "state": state_name(state)}),
        );
        if state == RTCPeerConnectionState::Connected {
            self.connected.store(true, Ordering::Release);
            self.force_keyframe.store(true, Ordering::Release);
        } else if matches!(
            state,
            RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Closed
        ) {
            self.connected.store(false, Ordering::Release);
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let control = self.control.clone();
        if !control.load(Ordering::Acquire) {
            let _ = channel.close().await;
            return;
        }
        let label = channel.label().await.unwrap_or_default();
        if label != "lanfly-control" {
            let _ = channel.close().await;
            return;
        }
        let events = self.events.clone();
        let runtime = self.runtime.clone();
        runtime.spawn(Box::pin(async move {
            loop {
                match channel.poll().await {
                    Some(DataChannelEvent::OnMessage(message)) => {
                        if message.data.len() > 4096 {
                            continue;
                        }
                        let text = String::from_utf8_lossy(&message.data).into_owned();
                        if let Err(error) = desktop_input::handle(&text) {
                            push_event(&events, json!({"kind": "input-error", "message": error}));
                        }
                    }
                    Some(DataChannelEvent::OnClose) | None => break,
                    _ => {}
                }
            }
            desktop_input::reset();
        }));
    }
}

/// Marks inbound PLI/FIR as application-deliverable so the sender can force a keyframe.
#[derive(Default)]
struct KeyframeFeedback {
    read: VecDeque<rtc::interceptor::TaggedPacket>,
    write: VecDeque<rtc::interceptor::TaggedPacket>,
}

impl KeyframeFeedback {
    fn new() -> Self {
        Self::default()
    }
}

impl sansio::Protocol<rtc::interceptor::TaggedPacket, rtc::interceptor::TaggedPacket, ()>
    for KeyframeFeedback
{
    type Rout = rtc::interceptor::TaggedPacket;
    type Wout = rtc::interceptor::TaggedPacket;
    type Eout = ();
    type Error = rtc::shared::error::Error;
    type Time = Instant;

    fn handle_read(
        &mut self,
        mut message: rtc::interceptor::TaggedPacket,
    ) -> Result<(), Self::Error> {
        if let rtc::interceptor::Packet::Rtcp(packets) = &message.message.packet {
            let wants_keyframe = packets.iter().any(|packet| {
                packet
                    .as_any()
                    .downcast_ref::<PictureLossIndication>()
                    .is_some()
                    || packet.as_any().downcast_ref::<FullIntraRequest>().is_some()
            });
            if wants_keyframe {
                message
                    .message
                    .add(rtc::interceptor::Attribute::DeliverToApplication);
            }
        }
        self.read.push_back(message);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read.pop_front()
    }

    fn handle_write(&mut self, message: rtc::interceptor::TaggedPacket) -> Result<(), Self::Error> {
        self.write.push_back(message);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write.pop_front()
    }
}

impl Interceptor for KeyframeFeedback {
    fn bind_local_stream(&mut self, _info: &rtc::interceptor::StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &rtc::interceptor::StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &rtc::interceptor::StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &rtc::interceptor::StreamInfo) {}
}

struct Session {
    id: String,
    runtime: Arc<tokio::runtime::Runtime>,
    events: Arc<Mutex<VecDeque<Value>>>,
    force_keyframe: Arc<AtomicBool>,
    connected: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    capture: Mutex<Option<Capture>>,
    encoder: Mutex<Option<Encoder>>,
    pc: tokio::sync::Mutex<Option<Box<dyn PeerConnection>>>,
    track: Arc<TrackLocalStaticSample>,
    sender: Arc<dyn RtpSender>,
    ssrc: u32,
    payload_type: Arc<AtomicU8>,
    encoded_queue: Arc<FrameQueue>,
    streaming: AtomicBool,
    stopped: AtomicBool,
    width: u32,
    height: u32,
    bitrate: AtomicU64,
}

impl Session {
    fn offer(&self, sdp: &str) -> Result<String, String> {
        let offer: RTCSessionDescription =
            serde_json::from_str(sdp).map_err(|_| "DESKTOP_SDP_INVALID".to_owned())?;
        if offer.sdp_type != rtc::peer_connection::sdp::RTCSdpType::Offer {
            return Err("DESKTOP_SDP_INVALID".to_owned());
        }
        let answer = self.runtime.block_on(async {
            let guard = self.pc.lock().await;
            let pc = guard
                .as_ref()
                .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
            pc.set_remote_description(offer)
                .await
                .map_err(|error| format!("DESKTOP_SDP_FAILED: {error}"))?;
            let mut answer = pc
                .create_answer(None)
                .await
                .map_err(|error| format!("DESKTOP_ANSWER_FAILED: {error}"))?;
            pc.set_local_description(answer.clone())
                .await
                .map_err(|error| format!("DESKTOP_ANSWER_FAILED: {error}"))?;
            // Advertise the level emitted by VideoToolbox to the remote peer. The local
            // description keeps the negotiated default; level asymmetry is permitted by RFC 6184.
            answer.sdp = advertise_h264_level(
                &answer.sdp,
                self.width,
                self.height,
                self.bitrate.load(Ordering::Relaxed) as u32,
            );
            Ok::<_, String>(answer)
        })?;
        let parameters = self
            .runtime
            .block_on(async { self.sender.get_parameters().await })
            .map_err(|error| format!("DESKTOP_CODEC_FAILED: {error}"))?;
        let payload_type = parameters
            .rtp_parameters
            .codecs
            .first()
            .map(|codec| codec.payload_type)
            .ok_or_else(|| "DESKTOP_CODEC_FAILED".to_owned())?;
        self.payload_type.store(payload_type, Ordering::Release);
        self.force_keyframe.store(true, Ordering::Release);
        self.start_streaming();
        serde_json::to_string(&answer).map_err(|_| "DESKTOP_SDP_INVALID".to_owned())
    }

    fn add_ice(&self, candidate: &str) -> Result<(), String> {
        let candidate: RTCIceCandidateInit =
            serde_json::from_str(candidate).map_err(|_| "DESKTOP_ICE_INVALID".to_owned())?;
        self.runtime.block_on(async {
            let guard = self.pc.lock().await;
            let pc = guard
                .as_ref()
                .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
            pc.add_ice_candidate(candidate)
                .await
                .map_err(|error| format!("DESKTOP_ICE_FAILED: {error}"))
        })?;
        Ok(())
    }

    fn start_streaming(&self) {
        if self.streaming.swap(true, Ordering::AcqRel) {
            return;
        }
        let queue = self.encoded_queue.clone();
        let track = self.track.clone();
        let connected = self.connected.clone();
        let feedback_track = self.track.clone();
        let feedback_keyframe = self.force_keyframe.clone();
        let feedback_running = self.running.clone();
        self.runtime.spawn(Box::pin(async move {
            while feedback_running.load(Ordering::Acquire) {
                match feedback_track.poll().await {
                    Some(TrackLocalEvent::OnRtcpPacket(packets))
                        if packets.iter().any(|packet| {
                            packet
                                .as_any()
                                .downcast_ref::<PictureLossIndication>()
                                .is_some()
                                || packet.as_any().downcast_ref::<FullIntraRequest>().is_some()
                        }) =>
                    {
                        feedback_keyframe.store(true, Ordering::Release);
                    }
                    None => break,
                    _ => {}
                }
            }
        }));
        let ssrc = self.ssrc;
        let payload_type = self.payload_type.clone();
        let running = self.running.clone();
        self.runtime.spawn(Box::pin(async move {
            let mut waiting_for_keyframe = true;
            while running.load(Ordering::Acquire) {
                if !connected.load(Ordering::Acquire) {
                    // The transport is not writable yet. Do not consume the queue: the first
                    // keyframe sent before ICE/DTLS completes would otherwise be lost and the
                    // decoder would wait for a PLI-triggered keyframe.
                    waiting_for_keyframe = true;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                }
                let Some(frame) = queue.wait_frame(Duration::from_millis(100)).await else {
                    continue;
                };
                if waiting_for_keyframe && !frame.keyframe {
                    continue;
                }
                waiting_for_keyframe = false;
                let payload_type = payload_type.load(Ordering::Acquire);
                if payload_type == 0 {
                    continue;
                }
                let sample = Sample {
                    data: frame.data,
                    duration: frame.duration,
                    timestamp: Instant::now(),
                    packet_timestamp: 0,
                    prev_dropped_packets: 0,
                    prev_padding_packets: 0,
                };
                // Before the connection becomes writable write_sample returns an error; frames
                // are intentionally dropped rather than buffered so latency never accumulates.
                let _ = track.write_sample(ssrc, payload_type, &sample, &[]).await;
            }
        }));
    }

    fn poll_events(&self) -> Value {
        let mut values = Vec::new();
        if let Ok(mut queue) = self.events.lock() {
            while let Some(value) = queue.pop_front() {
                if value.get("kind").and_then(Value::as_str) == Some("keyframe") {
                    self.force_keyframe.store(true, Ordering::Release);
                    continue;
                }
                values.push(value);
            }
        }
        if let Ok(capture) = self.capture.lock()
            && let Some(capture) = capture.as_ref()
            && let Some(error) = capture.take_error()
        {
            values.push(json!({"kind": "error", "message": error}));
        }
        if let Ok(encoder) = self.encoder.lock()
            && let Some(encoder) = encoder.as_ref()
            && let Some(error) = encoder.take_error()
        {
            values.push(json!({"kind": "error", "message": error}));
        }
        Value::Array(values)
    }

    fn set_bitrate(&self, bitrate: u32) -> Result<(), String> {
        let bitrate = bitrate.clamp(256_000, 32_000_000);
        self.bitrate.store(bitrate as u64, Ordering::Relaxed);
        if let Ok(encoder) = self.encoder.lock()
            && let Some(encoder) = encoder.as_ref()
            && !encoder.set_bitrate(bitrate)
        {
            return Err("DESKTOP_BITRATE_FAILED".to_owned());
        }
        Ok(())
    }

    fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::Release);
    }

    fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        self.running.store(false, Ordering::Release);
        self.encoded_queue.close();
        if let Ok(mut capture) = self.capture.lock()
            && let Some(mut capture) = capture.take()
        {
            capture.stop();
        }
        if let Ok(mut encoder) = self.encoder.lock()
            && let Some(mut encoder) = encoder.take()
        {
            encoder.stop();
        }
        desktop_input::reset();
        let pc = self.runtime.block_on(async { self.pc.lock().await.take() });
        if let Some(pc) = pc {
            let _ = self.runtime.block_on(async { pc.close().await });
        }
    }
}

struct DesktopState {
    session: Option<Arc<Session>>,
}

static SERVICE: OnceLock<Mutex<DesktopState>> = OnceLock::new();

fn service() -> &'static Mutex<DesktopState> {
    SERVICE.get_or_init(|| Mutex::new(DesktopState { session: None }))
}

fn take_session(id: Option<&str>) -> Option<Arc<Session>> {
    let mut state = service().lock().unwrap();
    let matches = state
        .session
        .as_ref()
        .map(|session| id.is_none() || id == Some(session.id.as_str()))
        .unwrap_or(false);
    if matches { state.session.take() } else { None }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn new_ssrc() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(1);
    (nanos ^ (std::process::id() << 16) ^ (now_unix_ms() as u32)) | 1
}

fn local_socket_address(value: Option<&str>) -> String {
    let address = value
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    match address {
        IpAddr::V4(_) => format!("{address}:0"),
        IpAddr::V6(_) => format!("[{address}]:0"),
    }
}

/// The browser offer usually advertises a low H.264 level, but the actual stream can be a
/// 2940x1912 Retina capture at up to 32 Mbps. Rewrite the fmtp level so Chrome configures its
/// decoder for the real frame size and bitrate instead of rejecting or downscaling the stream.
fn advertise_h264_level(sdp: &str, width: u32, height: u32, bitrate: u32) -> String {
    const KEY: &str = "profile-level-id=";
    let macroblocks = width.div_ceil(16) * height.div_ceil(16);
    let level = if macroblocks <= 8_192 && bitrate <= 14_000_000 {
        "42e028" // Level 4.0
    } else if macroblocks <= 8_704 && bitrate <= 20_000_000 {
        "42e02a" // Level 4.2
    } else if macroblocks <= 22_080 && bitrate <= 50_000_000 {
        "42e032" // Level 5.0
    } else {
        "42e033" // Level 5.1
    };
    let mut output = String::with_capacity(sdp.len());
    let mut rest = sdp;
    while let Some(position) = rest.find(KEY) {
        let end = position + KEY.len();
        output.push_str(&rest[..end]);
        let value = &rest[end..];
        if value.len() >= 6 && value[..6].chars().all(|ch| ch.is_ascii_hexdigit()) {
            output.push_str(level);
            rest = &value[6..];
        } else {
            rest = value;
        }
    }
    output.push_str(rest);
    output
}

fn h264_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_H264.to_owned(),
            clock_rate: 90_000,
            channels: 0,
            // Constrained Baseline; the encoder is configured to match this profile.
            sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028"
                .to_owned(),
            rtcp_feedback: vec![
                RTCPFeedback {
                    typ: "nack".to_owned(),
                    parameter: String::new(),
                },
                RTCPFeedback {
                    typ: "nack".to_owned(),
                    parameter: "pli".to_owned(),
                },
                RTCPFeedback {
                    typ: "goog-remb".to_owned(),
                    parameter: String::new(),
                },
            ],
        },
        payload_type: H264_PAYLOAD_TYPE,
    }
}

type PeerParts = (
    Box<dyn PeerConnection>,
    Arc<TrackLocalStaticSample>,
    Arc<dyn RtpSender>,
    u32,
);

fn build_peer(
    runtime: &tokio::runtime::Runtime,
    handler: Arc<DesktopHandler>,
    local_address: Option<&str>,
    session_id: &str,
) -> Result<PeerParts, String> {
    let track_ssrc = new_ssrc();
    let codec = h264_codec();
    let mut media = MediaEngine::default();
    media
        .register_codec(codec.clone(), RtpCodecKind::Video)
        .map_err(|error| format!("DESKTOP_CODEC_FAILED: {error}"))?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .map_err(|error| format!("DESKTOP_WEBRTC_BUILD: {error}"))?;
    let registry = registry.with(Slot::from(14_000), KeyframeFeedback::new());
    let setting_engine = SettingEngineBuilder::new()
        .with_multicast_dns_mode(rtc::ice::mdns::MulticastDnsMode::QueryOnly)
        .with_multicast_dns_timeout(Some(Duration::from_secs(10)))
        .with_answering_dtls_role(RTCDtlsRole::Server)
        .build();
    let udp_address = local_socket_address(local_address);
    let runtime_adapter: Arc<dyn Runtime> = Arc::new(TokioRuntime);
    let track = Arc::new(
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                format!("lanfly-desktop-stream-{session_id}"),
                format!("lanfly-desktop-track-{session_id}"),
                "lanfly desktop".to_owned(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(track_ssrc),
                        ..Default::default()
                    },
                    codec: codec.rtp_codec.clone(),
                    ..Default::default()
                }],
            ),
        )
        .map_err(|error| format!("DESKTOP_CODEC_FAILED: {error}"))?,
    );
    runtime
        .block_on(async {
            let pc = PeerConnectionBuilder::new()
                .with_configuration(
                    RTCConfigurationBuilder::new()
                        .with_ice_servers(vec![])
                        .with_ice_transport_policy(RTCIceTransportPolicy::All)
                        .build(),
                )
                .with_media_engine(media)
                .with_interceptor_registry(registry)
                .with_setting_engine(setting_engine)
                .with_handler(handler)
                .with_runtime(runtime_adapter)
                .with_udp_addrs(vec![udp_address])
                .build()
                .await
                .map_err(|error| format!("DESKTOP_WEBRTC_BUILD: {error}"))?;
            let sender = pc
                .add_track(track.clone() as Arc<dyn webrtc::media_stream::track_local::TrackLocal>)
                .await
                .map_err(|error| format!("DESKTOP_WEBRTC_TRACK: {error}"))?;
            Ok::<_, String>((Box::new(pc) as Box<dyn PeerConnection>, sender))
        })
        .map(|(pc, sender)| (pc, track, sender, track_ssrc))
}

pub fn status() -> Value {
    let displays = desktop_capture::displays();
    let main = desktop_capture::main_display();
    let display = main.map(|display| {
        json!({
            "id": display.id,
            "width": display.width,
            "height": display.height,
            "scale": display.scale,
            "logicalWidth": display.logical_width,
            "logicalHeight": display.logical_height,
            "originX": display.origin_x,
            "originY": display.origin_y,
        })
    });
    let session = service().lock().ok().and_then(|state| {
        state
            .session
            .as_ref()
            .map(|session| (session.width, session.height, session.id.clone()))
    });
    json!({
        "supported": cfg!(target_os = "macos"),
        "available": true,
        "screenRecording": desktop_capture::screen_recording(),
        "accessibility": desktop_input::accessible(),
        "screens": displays.len(),
        "display": display,
        "session": session.map(|(width, height, id)| json!({"id": id, "width": width, "height": height})),
    })
}

pub fn request_permissions() {
    desktop_capture::request_screen_recording();
    desktop_input::request_permissions();
}

pub fn start(session_id: &str, config_json: &str) -> Result<Value, String> {
    let config: StartConfig =
        serde_json::from_str(config_json).map_err(|_| "DESKTOP_INVALID_CONFIG".to_owned())?;
    if !(160..=3840).contains(&config.max_width)
        || !(120..=2160).contains(&config.max_height)
        || !(1..=60).contains(&config.fps)
        || !(128_000..=32_000_000).contains(&config.bitrate)
    {
        return Err("DESKTOP_INVALID_CONFIG".to_owned());
    }
    if !desktop_capture::screen_recording() {
        return Err("DESKTOP_PERMISSION".to_owned());
    }
    let old = take_session(None);
    if let Some(old) = old {
        old.shutdown();
    }

    let (capture_tx, capture_rx) = crossbeam_channel::bounded::<CapturedFrame>(2);
    let mut capture = Capture::start(config.max_width, config.max_height, config.fps, capture_tx)?;
    let force_keyframe = Arc::new(AtomicBool::new(true));
    let encoded_queue = FrameQueue::new(3, force_keyframe.clone());
    let mut encoder = match Encoder::start(
        capture.width(),
        capture.height(),
        config.fps,
        config.bitrate,
        capture_rx,
        encoded_queue.clone(),
        force_keyframe.clone(),
    ) {
        Ok(encoder) => encoder,
        Err(error) => {
            capture.stop();
            return Err(error);
        }
    };

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("lanfly-desktop")
        .enable_all()
        .build()
    {
        Ok(runtime) => Arc::new(runtime),
        Err(_) => {
            encoder.stop();
            capture.stop();
            return Err("DESKTOP_RUNTIME_FAILED".to_owned());
        }
    };
    let events = Arc::new(Mutex::new(VecDeque::new()));
    let control = Arc::new(AtomicBool::new(config.control));
    let connected = Arc::new(AtomicBool::new(false));
    let handler = Arc::new(DesktopHandler {
        events: events.clone(),
        force_keyframe: force_keyframe.clone(),
        control: control.clone(),
        connected: connected.clone(),
        runtime: Arc::new(TokioRuntime),
    });
    let (pc, track, sender, ssrc) = match build_peer(
        &runtime,
        handler,
        config.local_address.as_deref(),
        session_id,
    ) {
        Ok(value) => value,
        Err(error) => {
            encoder.stop();
            capture.stop();
            return Err(error);
        }
    };

    let actual_width = capture.width();
    let actual_height = capture.height();
    let session = Arc::new(Session {
        id: session_id.to_owned(),
        runtime,
        events,
        force_keyframe,
        connected,
        running: Arc::new(AtomicBool::new(true)),
        capture: Mutex::new(Some(capture)),
        encoder: Mutex::new(Some(encoder)),
        pc: tokio::sync::Mutex::new(Some(pc)),
        track,
        sender,
        ssrc,
        payload_type: Arc::new(AtomicU8::new(0)),
        encoded_queue,
        streaming: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        width: actual_width,
        height: actual_height,
        bitrate: AtomicU64::new(config.bitrate as u64),
    });
    let width = actual_width;
    let height = actual_height;
    *service().lock().unwrap() = DesktopState {
        session: Some(session),
    };
    Ok(json!({
        "sessionId": session_id,
        "width": width,
        "height": height,
        "control": config.control,
    }))
}

pub fn offer(session_id: &str, sdp: &str) -> Result<String, String> {
    let session = service()
        .lock()
        .ok()
        .and_then(|state| state.session.clone())
        .filter(|session| session.id == session_id)
        .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
    session.offer(sdp)
}

pub fn add_ice(session_id: &str, candidate: &str) -> Result<(), String> {
    let session = service()
        .lock()
        .ok()
        .and_then(|state| state.session.clone())
        .filter(|session| session.id == session_id)
        .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
    session.add_ice(candidate)
}

pub fn stop(session_id: &str) -> Result<(), String> {
    let session = take_session(Some(session_id));
    if let Some(session) = session {
        session.shutdown();
    }
    Ok(())
}

pub fn stop_all() {
    if let Some(session) = take_session(None) {
        session.shutdown();
    }
}

pub fn poll() -> Value {
    let session = service()
        .lock()
        .ok()
        .and_then(|state| state.session.clone());
    match session {
        Some(session) => session.poll_events(),
        None => Value::Array(Vec::new()),
    }
}

pub fn set_bitrate(session_id: &str, bitrate: u32) -> Result<(), String> {
    let session = service()
        .lock()
        .ok()
        .and_then(|state| state.session.clone())
        .filter(|session| session.id == session_id)
        .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
    session.set_bitrate(bitrate)
}

pub fn request_keyframe(session_id: &str) -> Result<(), String> {
    let session = service()
        .lock()
        .ok()
        .and_then(|state| state.session.clone())
        .filter(|session| session.id == session_id)
        .ok_or_else(|| "DESKTOP_SESSION_CLOSED".to_owned())?;
    session.request_keyframe();
    Ok(())
}

pub fn input(value: &str) -> Result<(), String> {
    desktop_input::handle(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_codec_advertises_constrained_baseline_and_pli() {
        let codec = h264_codec();
        assert!(
            codec
                .rtp_codec
                .sdp_fmtp_line
                .contains("profile-level-id=42e028")
        );
        assert!(
            codec
                .rtp_codec
                .rtcp_feedback
                .iter()
                .any(|feedback| feedback.typ == "nack" && feedback.parameter == "pli")
        );
    }

    #[test]
    fn answer_advertises_the_level_videotoolbox_emits() {
        let sdp =
            "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";
        assert!(
            advertise_h264_level(sdp, 1920, 1080, 4_000_000).contains("profile-level-id=42e028")
        );
        assert!(
            advertise_h264_level(sdp, 2940, 1912, 16_000_000).contains("profile-level-id=42e032")
        );
        assert!(
            advertise_h264_level(sdp, 3840, 2160, 32_000_000).contains("profile-level-id=42e033")
        );
        assert!(advertise_h264_level("no fmtp here", 1920, 1080, 4_000_000).eq("no fmtp here"));
    }

    #[test]
    fn local_socket_address_is_lan_safe() {
        assert_eq!(local_socket_address(Some("192.168.1.7")), "192.168.1.7:0");
        assert_eq!(local_socket_address(Some("fe80::1")), "[fe80::1]:0");
        assert_eq!(local_socket_address(None), "0.0.0.0:0");
    }
}
