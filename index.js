// sdk/index.js

import * as faceapi from "face-api.js";

const EVENT_CODES = {
  // Regular Events
  upSdkSetupSuccess: 1001,
  upSdkProcStarted: {
    started: 1101,
  },
  upSdkProcStopped: {
    byProctee: 1201,
  },

  // Custom Events
  upSdkSuccess: {
    screenSharingStarted: 2001,
    faceDetectionStarted: 2002,
    noiseDetectionStarted: 2003,
  },
  upSdkError: {
    errorLoadingFaceModels: 5001,
    errorStartingFaceDetection: 5002,
    errorStartingNoiseDetection: 5003,
    screenSharingDenied: 5004,
    errorCapturingScreenshot: 5005,
    errorUploadingEvidence: 5006,
  },
  upSdkLog: {
    noFaceDetected: 3001,
    multipleFacesDetected: 3002,
    tabIn: 3003,
    tabOut: 3004,
    fullScreenExited: 3005,
    disabledKeys: 3006, // Combined event for disabled keys
    noiseDetected: 3007,
    multipleScreensDetected: 3008,
    pageReloadDetected: 3009,
    screenSharingStopped: 3010,
    networkDisconnected: 3011,
    networkReconnected: 3012,
  },
};

class Proctoring {
  constructor() {
    this.proctoring = false;
    this.stream = null;
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleFullScreenChange = this.handleFullScreenChange.bind(this);
    this.monitorCheckInterval = null;
    this.options = {};
    this.proctorId = null;
    this.camera = null;
    this.csvData = [];
    this.violationCounts = {};
    this.violations = {
      tabSwitchOrMinimized: [],
      fullScreenExited: [],
      ctrlPressed: [],
      shiftPressed: [],
      rightClicked: [],
      functionKeyPressed: [],
      noiseDetected: [],
      networkDisconnected: [],
      networkReconnected: [],
    };
    this.exitingFullscreen = false;
    this.specificAnomalyCount = 0;
    this.screenshotInProgress = false;
    this.faceDetectionInterval = null;
    this.audioContext = null;
    this.mediaStreamSource = null;
    this.analyser = null;
    this.screenStream = null;
    this.audioStream = null;
    this.audioContext = null;
    this.noiseCheckInterval = null;
    this.mediaRecorder = null;
    this.recording = false;
    this.noiseThreshold = 50;
    this.videoElement = null;
    this.violationLogTimeouts = {};
    this.lastTabOutTime = null;
    this.lastTabInTime = null;

    if (typeof window !== "undefined") {
      window.addEventListener("load", this.logPageLoad.bind(this));
      document.addEventListener(
        "fullscreenchange",
        this.handleFullScreenChange
      );
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange
      );
    }
  }

  async loadModels() {
    const modelPath = `https://dev-sdk-proctor.ultiwebtechnologies.com/models`;
    console.log(`Loading models from: ${modelPath}`);

    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelPath),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelPath),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelPath),
      ]);

      console.log("Models loaded successfully");
      this.triggerEvent("upSdkSetupSuccess");
      this.faceapi = faceapi;
    } catch (error) {
      this.triggerEvent("upSdkError", "errorLoadingFaceModels");
      console.error("Error loading face models:", error);
    }
  }

  async promptScreenShare() {
    let isFullScreenShared = false;

    while (!isFullScreenShared) {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: "monitor",
            cursor: "always",
            logicalSurface: true,
          },
          audio: false,
        });

        const track = this.screenStream.getVideoTracks()[0];
        if (track && track.kind === "video") {
          const settings = track.getSettings();
          if (settings.displaySurface === "monitor") {
            isFullScreenShared = true;

            this.triggerEvent("upSdkSuccess", "screenSharingStarted");
            track.onended = async () => {
              const event = "screen-sharing-stopped";
              this.triggerEvent("upSdkLog", "screenSharingStopped");
              const timestamp = new Date().toISOString();
              this.logViolation(event);
              alert("Please share your entire screen.");
              isFullScreenShared = false;
              await this.promptScreenShare();
            };
          } else {
            alert("Please share your entire screen.");
            this.screenStream.getTracks().forEach((track) => track.stop());
          }
        } else {
          alert("Please share your entire screen.");
        }
      } catch (error) {
        console.error("Screen sharing was canceled or failed: ", error);
        if (error.name === "NotAllowedError") {
          this.triggerEvent("upSdkError", "screenSharingDenied");
          alert(
            "Screen sharing was denied. Please allow screen sharing and try again."
          );
        } else {
          alert("Please share your entire screen.");
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    return isFullScreenShared;
  }

  async sendProctoringTime(action, timestamp, proctorId) {
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/proctoring-time`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        timestamp,
        proctorId,
      }),
      mode: "cors",
    })
      .then((response) => response.json())
      .then((data) => {
        console.log(`Proctoring ${action} time sent successfully:`, data);
      })
      .catch((error) => {
        console.error(`Error sending proctoring ${action} time:`, error);
      });
  }

  async startProctoring(options, proctorId, all = false) {
    const startProctoringTime = new Date().toISOString();
    this.sendProctoringTime("start", startProctoringTime, proctorId);

    this.violations = {
      tabSwitchOrMinimized: [],
      fullScreenExited: [],
      ctrlPressed: [],
      shiftPressed: [],
      rightClicked: [],
      functionKeyPressed: [],
      noiseDetected: [],
      networkDisconnected: [],
      networkReconnected: [],
    };
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    }

    let started = await this.promptScreenShare();
    if (!started) return false;

    if (all) {
      options = {
        tabSwitchOrMinimize: true,
        capturePageReloads: true,
        enforceFullScreen: true,
        // captureScreenshots: true,
        disableKeys: true,
        disableMultipleScreens: true,
        detectNoise: true,
        faceDetection: true,
        detectNetworkDisruption: true,
      };
    }

    this.options.captureScreenshot = true;
    this.options = options;
    this.proctorId = proctorId;
    this.proctoring = true;

    if (this.options.faceDetection) {
      await this.loadModels();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        const faceDetected = await this.checkInitialFaceDetection();
        if (!faceDetected) {
          alert("Please ensure only one face is visible in the camera.");
          this.stopProctoring();
          return false;
        }
        this.startCameraFaceDetection();
      } catch (error) {
        console.error("Error initializing camera stream:", error);
        this.stopProctoring();
        return false;
      }
      this.triggerEvent("upSdkSuccess", "faceDetectionStarted");
    }

    if (this.options.tabSwitchOrMinimize) {
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange.bind(this)
      );
    }

    if (this.options.disableKeys) {
      window.addEventListener("keydown", this.disableKeys.bind(this));
      window.addEventListener("contextmenu", this.disableRightClick.bind(this));
    }

    if (this.options.capturePageReloads) {
      window.addEventListener(
        "beforeunload",
        this.handleBeforeUnload.bind(this)
      );
    }

    if (this.options.enforceFullScreen) {
      this.enterFullScreen();
    }

    if (this.options.disableMultipleScreens) {
      this.startMonitorCheck();
    }

    if (this.options.detectNoise) {
      this.startNoiseDetection();
      this.triggerEvent("upSdkSuccess", "noiseDetectionStarted");
    }

    if (this.options.detectNetworkDisruption) {
      if (!this.networkEventListenersAdded) {
        window.addEventListener(
          "online",
          this.handleNetworkReconnect.bind(this)
        );
        window.addEventListener(
          "offline",
          this.handleNetworkDisconnect.bind(this)
        );
        this.networkEventListenersAdded = true;
      }
    }

    await this.loadModels();

    this.triggerEvent("upSdkProcStarted", "started");
    return true;
  }

  async checkInitialFaceDetection() {
    if (
      !this.stream ||
      !this.stream.getVideoTracks ||
      this.stream.getVideoTracks().length === 0
    ) {
      throw new Error("Stream is not valid or contains no video tracks.");
    }

    const videoTrack = this.stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.kind !== "video") {
      throw new Error("No valid video track found.");
    }

    const videoElement = document.createElement("video");
    videoElement.srcObject = this.stream;
    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        resolve();
      };
    });

    const detections = await faceapi.detectAllFaces(
      videoElement,
      new faceapi.TinyFaceDetectorOptions()
    );

    videoElement.pause();
    videoElement.srcObject = null;

    if (detections.length === 1) {
      this.triggerEvent("upSdkLog", "singleFaceDetected");
      return true;
    } else if (detections.length === 0) {
      this.triggerEvent("upSdkLog", "noFaceDetected");
    } else {
      this.triggerEvent("upSdkLog", "multipleFacesDetected");
    }

    return false;
  }

  updateReportWithStopProctoringTime(proctorId, stopProctoringTime) {
    fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/update-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        proctorId: this.proctorId,
        stopProctoringTime,
      }),
      mode: "cors",
    })
      .then((response) => response.json())
      .then((data) => {
        console.log(`Proctoring stop time sent successfully:`, data);
      })
      .catch((error) => {
        console.error(`Error sending proctoring stop time:`, error);
      });
  }

  async stopProctoring() {
    this.proctoring = false;

    const stopProctoringTime = new Date().toISOString();
    this.updateReportWithStopProctoringTime(this.proctorId, stopProctoringTime);

    clearInterval(this.noiseCheckInterval);
    clearInterval(this.faceDetectionInterval);

    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => {
        if (track.readyState !== "ended") {
          track.stop();
        }
      });
      this.screenStream = null;
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => {
        if (track.readyState !== "ended") {
          track.stop();
        }
      });
      this.audioStream = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        if (track.readyState !== "ended") {
          track.stop();
        }
      });
      this.stream = null;
    }

    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange.bind(this)
    );

    window.removeEventListener("keydown", this.disableKeys.bind(this));
    window.removeEventListener(
      "contextmenu",
      this.disableRightClick.bind(this)
    );

    window.removeEventListener(
      "beforeunload",
      this.handleBeforeUnload.bind(this)
    );

    if (this.networkEventListenersAdded) {
      window.removeEventListener(
        "online",
        this.handleNetworkReconnect.bind(this)
      );
      window.removeEventListener(
        "offline",
        this.handleNetworkDisconnect.bind(this)
      );
      this.networkEventListenersAdded = false;
    }

    this.exitFullScreen();
    this.stopMonitorCheck();
    this.stopNoiseDetection();
    this.stopFaceDetection();

    this.triggerEvent("upSdkProcStopped", "byProctee");

    let finalScreenshotBase64 = null;
    try {
      console.log("Attempting to capture final screenshot...");
      finalScreenshotBase64 = await this.captureScreenshot(
        "proctoring-stopped",
        new Date().toISOString(),
        true
      );
      console.log("Final screenshot base64:", { finalScreenshotBase64 });
    } catch (error) {
      console.error("Error capturing final screenshot:", error);
    }

    console.log(this.violations);

    return { violations: this.violations, finalScreenshotBase64 };
  }

  async startCameraFaceDetection() {
    try {
      const videoTrack = this.stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.kind !== "video") {
        throw new Error("No valid video track found.");
      }

      this.videoElement = document.createElement("video");
      this.videoElement.srcObject = this.stream;
      this.videoElement.onloadedmetadata = () => {
        this.videoElement.play();

        this.videoElement.width = this.videoElement.videoWidth;
        this.videoElement.height = this.videoElement.videoHeight;

        if (this.options.faceDetection) {
          this.startFaceDetection();
        }
      };
    } catch (error) {
      console.error("Error starting camera face detection:", error);
    }
  }

  async stopCameraFaceDetection() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    this.stopFaceDetection();
  }

  async startFaceDetection() {
    await this.loadModels();
    if (
      !this.videoElement ||
      !(this.videoElement instanceof HTMLVideoElement)
    ) {
      console.error("Invalid or uninitialized video element");
      return;
    }

    if (this.proctoring) {
      this.faceDetectionInterval = setInterval(async () => {
        try {
          const detections = await faceapi.detectAllFaces(
            this.videoElement,
            new faceapi.TinyFaceDetectorOptions()
          );

          if (detections.length === 0) {
            setTimeout(() => {
              this.triggerEvent("upSdkLog", "noFaceDetected");
              const event = "no-face-detected";
              const timestamp = new Date().toISOString();
              this.captureScreenshot(event, timestamp, true);
            }, 3000);
          } else if (detections.length > 1) {
            setTimeout(() => {
              this.triggerEvent("upSdkLog", "multipleFacesDetected");
              const event = "multiple-faces-detected";
              const timestamp = new Date().toISOString();
              this.captureScreenshot(event, timestamp, true);
            }, 3000);
          }
        } catch (error) {
          this.triggerEvent("upSdkError", "errorStartingFaceDetection");
          console.error("Error detecting faces:", error);
        }
      }, 1000);
    }
  }

  stopFaceDetection() {
    if (this.faceDetectionInterval) {
      clearInterval(this.faceDetectionInterval);
      this.faceDetectionInterval = null;
    }
  }

  async startNoiseDetection() {
    console.log("Starting noise detection called");

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      console.log("Audio context created");
    } else {
      console.error("Audio context already exists");
      this.triggerEvent("upSdkError", "errorStartingNoiseDetection");
      return;
    }

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      console.log("Audio stream obtained");

      this.mediaStreamSource = this.audioContext.createMediaStreamSource(
        this.audioStream
      );
      this.analyser = this.audioContext.createAnalyser();
      this.mediaStreamSource.connect(this.analyser);
      this.analyser.fftSize = 256;
      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      this.mediaRecorder = new MediaRecorder(this.audioStream);
      const chunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        chunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/wav" });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          const base64data = reader.result.split(",")[1];
          this.triggerEvent("upSdkLog", "noiseDetected");
          const event = "noise-detected";
          const timestamp = new Date().toISOString();

          console.log(`Logging noise violation at ${timestamp} with evidence`);
          console.log("Base64 audio string", base64data);

          this.logViolation(event, base64data);
        };
      };

      this.noiseCheckInterval = setInterval(() => {
        const event = "noise-detected";
        this.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
        console.log("Average noise level: ", average);
        if (average > this.noiseThreshold) {
          this.logViolation("noise-detected");
        }

        if (average >= this.noiseThreshold && !this.recording) {
          this.recording = true;
          this.mediaRecorder.start();
          console.log("Started recording noise.");
        } else if (average < this.noiseThreshold && this.recording) {
          this.recording = false;
          this.mediaRecorder.stop();
          console.log("Stopped recording noise.");
        }
      }, 1000);
    } catch (error) {
      console.error("Error accessing audio stream: ", error);
      this.triggerEvent("upSdkError", "errorStartingNoiseDetection");
    }
  }

  async stopNoiseDetection() {
    if (this.noiseCheckInterval) {
      clearInterval(this.noiseCheckInterval);
      this.noiseCheckInterval = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((track) => track.stop());
      this.audioStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaRecorder && this.recording) {
      this.mediaRecorder.stop();
      this.recording = false;
    }
  }

  async captureAudio() {
    const mediaRecorder = new MediaRecorder(this.stream);
    const chunks = [];
    mediaRecorder.ondataavailable = (event) => {
      chunks.push(event.data);
    };
    mediaRecorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    mediaRecorder.stop();

    return new Promise((resolve) => {
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/wav" });
        const audioFileName = `${
          this.proctorId
        }_${new Date().toISOString()}_noise.wav`;
        this.downloadFile(blob, audioFileName);
        resolve(audioFileName);
      };
    });
  }

  async logViolation(violationType, evidence = null) {
    if (!this.proctoring) return;

    const delay = 100;
    if (this.violationLogTimeouts[violationType]) {
      clearTimeout(this.violationLogTimeouts[violationType]);
    }

    this.violationLogTimeouts[violationType] = setTimeout(async () => {
      console.log(
        `Logging violation: ${violationType} with evidence: ${!!evidence}`
      );

      if (violationType) {
        this.triggerEvent("upSdkLog", violationType);
      }

      const timestamp = new Date().toISOString();
      const folderName = violationType;

      const violation = {
        violationType,
        timestamp,
        evidence,
        folderName,
      };

      if (!this.violations[violationType]) {
        this.violations[violationType] = [];
      }

      if (violationType === "tab-switch-or-minimized" || evidence) {
        this.violations[violationType].push(violation);
        console.log(`Violation logged: ${violationType} at ${timestamp}`);
        console.log("Evidence data:", evidence);

        if (evidence) {
          try {
            const response = await this.uploadEvidence(
              violationType,
              evidence,
              timestamp,
              folderName
            );
            console.log("Evidence uploaded response:", response);
          } catch (error) {
            console.error("Error uploading evidence:", error);
          }
        } else {
          try {
            let screenshotData = null;
            screenshotData = await this.captureScreenshot(
              violationType,
              timestamp,
              true
            );

            if (screenshotData) {
              const response = await this.uploadEvidence(
                violationType,
                screenshotData,
                timestamp,
                folderName
              );
              console.log("Screenshot evidence uploaded response:", response);
            }
          } catch (error) {
            console.error(
              `Error capturing screenshot for ${violationType}:`,
              error
            );
          }
        }
      } else {
        this.violations[violationType].push(violation);
        console.log(`Violation logged: ${violationType} at ${timestamp}`);
        console.log("Evidence data:", evidence);

        if (evidence) {
          try {
            const response = await this.uploadEvidence(
              violationType,
              evidence,
              timestamp,
              folderName
            );
            console.log("Evidence uploaded response:", response);
          } catch (error) {
            console.error("Error uploading evidence:", error);
          }
        } else {
          try {
            let screenshotData = null;
            screenshotData = await this.captureScreenshot(
              violationType,
              timestamp,
              true
            );

            if (screenshotData) {
              const response = await this.uploadEvidence(
                violationType,
                screenshotData,
                timestamp,
                folderName
              );
              console.log("Screenshot evidence uploaded response:", response);
            }
          } catch (error) {
            console.error(
              `Error capturing screenshot for ${violationType}:`,
              error
            );
          }
        }
      }
    }, delay);
  }

  async uploadEvidence(violationType, evidence, timestamp) {
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/upload`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            proctorId: this.proctorId,
            violationType,
            evidence,
            timestamp,
            proctorSettings: this.options,
          }),
          mode: "cors",
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to upload evidence: ${response.statusText}`);
      }

      const data = await response.json();
      console.log("Evidence uploaded successfully:", data);
      return data;
    } catch (error) {
      this.triggerEvent("upSdkError", "errorUploadingEvidence");
      console.error("Error uploading evidence:", error);
      throw error;
    }
  }

  async getProctoringReport(proctorId) {
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/retrieve/${proctorId}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          mode: "cors",
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to retrieve report: ${response.statusText}`);
      }

      const report = await response.json();
      console.log("Proctoring report retrieved successfully:", report);
      return report;
    } catch (error) {
      console.error("Error retrieving proctoring report:", error);
      throw error;
    }
  }

  async captureScreenshot(event, timestamp, useScreenStream = false) {
    console.log(`Capturing screenshot for event: ${event} at ${timestamp}`);
    if (!this.proctoring || this.screenshotInProgress) return null;

    this.screenshotInProgress = true;

    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stream = useScreenStream ? this.screenStream : this.stream;
      const track = stream?.getVideoTracks()[0];
      if (!track || track.readyState !== "live" || track.kind !== "video") {
        console.error(
          "Failed to capture screenshot: No video track found or track is not of kind 'video'."
        );
        return null;
      }

      const canvas = document.createElement("canvas");
      const videoElement = document.createElement("video");

      videoElement.srcObject = stream;
      videoElement.play();

      await new Promise((resolve) => {
        videoElement.onloadedmetadata = () => {
          videoElement.width = videoElement.videoWidth;
          videoElement.height = videoElement.videoHeight;
          resolve();
        };
      });

      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const base64Data = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
      videoElement.pause();
      videoElement.srcObject = null;

      if (base64Data) {
        const screenshot = {
          timestamp: new Date().toISOString(),
          event,
          base64Data,
        };

        this.csvData.push(screenshot);
        await this.logViolation(event, base64Data);
      } else {
        console.error("Failed to capture screenshot.");
      }

      return base64Data;
    } catch (error) {
      this.triggerEvent("upSdkError", "errorCapturingScreenshot");
      console.error("Error capturing screenshot:", error);
      return null;
    } finally {
      this.screenshotInProgress = false;
    }
  }

  dataURLtoBlob(dataURL) {
    const byteString = atob(dataURL.split(",")[1]);
    const mimeString = dataURL.split(",")[0].split(":")[1].split(";")[0];
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);

    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i);
    }

    return new Blob([arrayBuffer], { type: mimeString });
  }

  downloadFile(blob, fileName) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  handleFullScreenChange() {
    if (
      this.proctoring &&
      this.options.enforceFullScreen &&
      !document.fullscreenElement
    ) {
      this.triggerEvent("upSdkLog", "fullScreenExited");
      const event = "full-screen-exited";
      const timestamp = new Date().toISOString();
      this.captureScreenshot(event, timestamp, true);
    }
  }

  handleVisibilityChange() {
    const currentTime = new Date().toISOString();

    if (this.proctoring && this.options.tabSwitchOrMinimize) {
      if (document.visibilityState === "hidden") {
        this.lastTabOutTime = currentTime;
        console.log(`Tab out at: ${this.lastTabOutTime}`);

        if (this.visibilityChangeTimeout) {
          clearTimeout(this.visibilityChangeTimeout);
        }

        this.visibilityChangeTimeout = setTimeout(() => {
          const event = "tabOut";
          this.captureScreenshot(event, this.lastTabOutTime, true);
        }, 1000);
      } else if (document.visibilityState === "visible") {
        this.lastTabInTime = currentTime;
        console.log(`Tab in at: ${this.lastTabInTime}`);

        if (this.visibilityChangeTimeout) {
          clearTimeout(this.visibilityChangeTimeout);
        }

        this.visibilityChangeTimeout = setTimeout(() => {
          const event = "tabIn";
          this.captureScreenshot(event, this.lastTabInTime, true);
        }, 1000);
      }
    }
  }

  handleBeforeUnload(event) {
    event.preventDefault();
    event.returnValue = "";
    const logEvent = "page-reload-or-exit-attempt";
    const timestamp = new Date().toISOString();
    this.captureScreenshot(logEvent, timestamp, true);
  }

  handleNetworkDisconnect() {
    const event = "network-disconnected";
    const timestamp = new Date().toISOString();
    this.triggerEvent("upSdkLog", "networkDisconnected");
    this.captureScreenshot(event, timestamp, true);
  }

  handleNetworkReconnect() {
    const event = "network-reconnected";
    const timestamp = new Date().toISOString();
    this.triggerEvent("upSdkLog", "networkReconnected");
    this.captureScreenshot(event, timestamp, true);
  }

  disableKeys(event) {
    const disabledKeys = ["Control", "Shift", "Alt", "Meta", "ContextMenu"];
    const isDisabledKey = disabledKeys.includes(event.key);

    if (isDisabledKey || event.key === "ContextMenu" || event.which === 93) {
      event.preventDefault();
      const keyPressed = {
        ctrlKeyPressed: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        functionKey: event.key,
        rightClick: event.which === 93,
      };
      const timestamp = new Date().toISOString();
      this.triggerEvent("upSdkLog", "disabledKeys", keyPressed);
      this.captureScreenshot("disabledKeys", timestamp, true);
    }
  }
  disableRightClick(event) {
    event.preventDefault();
    const timestamp = new Date().toISOString();
    this.triggerEvent("upSdkLog", "disabledKeys", { rightClick: true });
    this.captureScreenshot("disabledKeys", timestamp, true);
  }

  enterFullScreen() {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    } else if (document.documentElement.msRequestFullscreen) {
      document.documentElement.msRequestFullscreen();
    }
  }

  exitFullScreen() {
    if (document.fullscreenElement && !this.exitingFullscreen) {
      this.exitingFullscreen = true;
      document
        .exitFullscreen()
        .then(() => {
          this.exitingFullscreen = false;
          console.log("Exited fullscreen successfully");
        })
        .catch((err) => {
          this.exitingFullscreen = false;
          console.error("Error trying to exit fullscreen:", err);
        });
    }
  }

  startMonitorCheck() {
    this.monitorCheckInterval = setInterval(() => {
      if (this.proctoring) {
        const dualScreenCheck = window.screen.width !== window.innerWidth;

        if (dualScreenCheck) {
          const logEvent = "multipleScreensDetected";
          this.triggerEvent("upSdkLog", "multipleScreensDetected");

          const timestamp = new Date().toISOString();

          this.captureScreenshot(logEvent, timestamp, true);
        }
      }
    }, 3000);
  }

  stopMonitorCheck() {
    if (this.monitorCheckInterval) {
      clearInterval(this.monitorCheckInterval);
      this.monitorCheckInterval = null;
    }
  }

  logPageLoad() {
    const logEvent = "page-reloaded";
    this.triggerEvent("upSdkLog", "pageReloadDetected");
    const timestamp = new Date().toISOString();
    this.captureScreenshot(logEvent, timestamp);
  }

  triggerEvent(category, type = null) {
    const eventCode = type
      ? EVENT_CODES[category][type]
      : EVENT_CODES[category];
    const eventDetail = {
      category,
      type,
      code: eventCode,
    };
    const event = new CustomEvent("proctoringEvent", { detail: eventDetail });
    window.dispatchEvent(event);
  }
}

export default Proctoring;
