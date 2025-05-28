import { CodedError } from 'expo-modules-core';
import { useRef, useMemo, useImperativeHandle, } from 'react';
import { StyleSheet, View } from 'react-native';
import createElement from 'react-native-web/dist/exports/createElement';
import CameraManager from './ExpoCameraManager.web';
import { capture } from './web/WebCameraUtils';
import { PictureSizes } from './web/WebConstants';
import { useWebCameraStream } from './web/useWebCameraStream';
import { useWebQRScanner } from './web/useWebQRScanner';
const ExponentCamera = ({ facing, poster, ref, ...props }) => {
    const video = useRef(null);
    const native = useWebCameraStream(video, facing, props, {
        onCameraReady() {
            if (props.onCameraReady) {
                props.onCameraReady();
            }
        },
        onMountError: props.onMountError,
    });
    const isQRScannerEnabled = useMemo(() => {
        return Boolean(props.barcodeScannerSettings?.barcodeTypes?.includes('qr') && !!props.onBarcodeScanned);
    }, [props.barcodeScannerSettings?.barcodeTypes, props.onBarcodeScanned]);
    useWebQRScanner(video, {
        interval: 300,
        isEnabled: isQRScannerEnabled,
        captureOptions: { scale: 1, isImageMirror: native.type === 'front' },
        onScanned(event) {
            if (props.onBarcodeScanned) {
                props.onBarcodeScanned(event);
            }
        },
    });
    useImperativeHandle(ref, () => ({
        async getAvailablePictureSizes() {
            return PictureSizes;
        },
        async takePicture(options) {
            if (!video.current || video.current?.readyState !== video.current?.HAVE_ENOUGH_DATA) {
                throw new CodedError('ERR_CAMERA_NOT_READY', 'HTMLVideoElement does not have enough camera data to construct an image yet.');
            }
            const settings = native.mediaTrackSettings;
            if (!settings) {
                throw new CodedError('ERR_CAMERA_NOT_READY', 'MediaStream is not ready yet.');
            }
            return capture(video.current, settings, {
                ...options,
                // This will always be defined, the option gets added to a queue in the upper-level. We should replace the original so it isn't called twice.
                onPictureSaved(picture) {
                    if (options.onPictureSaved) {
                        options.onPictureSaved(picture);
                    }
                    if (props.onPictureSaved) {
                        props.onPictureSaved({ nativeEvent: { data: picture, id: -1 } });
                    }
                },
            });
        },
        async resumePreview() {
            if (video.current) {
                video.current.play();
            }
        },
        async pausePreview() {
            if (video.current) {
                video.current.pause();
            }
        },
        async stopRecording() {
            if (video.current && video.current.mediaRecorder && video.current.mediaRecorder.state === 'recording') {
                video.current.mediaRecorder.stop();
            } else {
                console.warn('No active recording to stop.');
            }
        },
        async record() {
            if (!video.current || video.current?.readyState !== video.current?.HAVE_ENOUGH_DATA) {
                throw new CodedError('ERR_CAMERA_NOT_READY', 'HTMLVideoElement does not have enough camera data to record.');
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                ...native.mediaTrackSettings,
                audio: true,
                video: true,
            });
            if (!stream) {
                console.log("native.mediaStream", stream);
                throw new CodedError('ERR_CAMERA_NOT_READY', 'MediaStream is not ready yet.');
            }
            // Use MediaRecorder API to record video
            return new Promise((resolve, reject) => {
                try {
                    const recordedChunks = [];
                    const mediaRecorder = new window.MediaRecorder(stream, { mimeType: 'video/webm' });
                    video.current.mediaRecorder = mediaRecorder; // Store the MediaRecorder instance for later use
                   
                    mediaRecorder.ondataavailable = (event) => {
                        if (event.data.size > 0) {
                            recordedChunks.push(event.data);
                        }
                    };

                    mediaRecorder.onstop = () => {
                        const blob = new Blob(recordedChunks, { type: 'video/webm' });
                        const uri = URL.createObjectURL(blob);
                        resolve({ uri, blob });
                    };

                    mediaRecorder.onerror = (event) => {
                        reject(new CodedError('ERR_CAMERA_RECORD', event.error?.message || 'Recording failed.'));
                    };

                    mediaRecorder.start();
                } catch (error) {
                    reject(new CodedError('ERR_CAMERA_RECORD', error.message));
                }
            });
        },
        async toggleRecording() {
            if (video.current && video.current.mediaRecorder) {
                const recorder = video.current.mediaRecorder;
                if (recorder.state === "recording") {
                    recorder.stop();
                } else if (recorder.state === "inactive") {
                    try {
                        recorder.start();
                    } catch (error) {
                        throw new CodedError("ERR_CAMERA_RECORD", error.message);
                    }
                } else {
                    throw new CodedError(
                        "ERR_CAMERA_RECORD",
                        `Cannot toggle recording in state: ${recorder.state}`
                    );
                }
            } else {
                throw new CodedError(
                    "ERR_CAMERA_NOT_READY",
                    "No MediaRecorder instance available to toggle recording."
                );
            }
        },
        async launchModernScanner() {
            console.warn('launchModernScanner is not supported on web.');
        },
        async getAvailableLenses() {
            console.warn('getAvailableLenses is not supported on web.');
            return [];
        },
    }), [native.mediaTrackSettings, props.onPictureSaved]);
    // TODO(Bacon): Create a universal prop, on native the microphone is only used when recording videos.
    // Because we don't support recording video in the browser we don't need the user to give microphone permissions.
    const isMuted = true;
    const style = useMemo(() => {
        const isFrontFacingCamera = native.type === CameraManager.Type.front;
        return [
            StyleSheet.absoluteFill,
            styles.video,
            {
                // Flip the camera
                transform: isFrontFacingCamera ? [{ scaleX: -1 }] : undefined,
            },
        ];
    }, [native.type]);
    return (<View pointerEvents="box-none" style={[styles.videoWrapper, props.style]}>
      <Video autoPlay playsInline muted={isMuted} poster={poster} pointerEvents={props.pointerEvents} ref={video} style={style}/>
      {props.children}
    </View>);
};
export default ExponentCamera;
const Video = (props) => createElement('video', { ...props });
const styles = StyleSheet.create({
    videoWrapper: {
        flex: 1,
        alignItems: 'stretch',
    },
    video: {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
    },
});
//# sourceMappingURL=ExpoCamera.web.js.map
