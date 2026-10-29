#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <tuple>
#include <vector>
#include <audioapi/utils/Result.hpp>

// Native boundaries only. The production recorder/writer methods are inserted
// from the installed, reproducibly patched package by audioNativePatch.test.ts.
namespace oboe {
enum class Result { OK, ErrorDisconnected, ErrorInternal };
inline const char *convertToText(Result value) { return value == Result::OK ? "OK" : "fixture error"; }
struct AudioStream {
  int starts = 0, stops = 0, closes = 0;
  bool failStart = false;
  std::shared_ptr<void> callbackOwner;
  Result requestStart() { starts++; return failStart ? Result::ErrorInternal : Result::OK; }
  void requestStop() { stops++; }
  void close() { closes++; callbackOwner.reset(); }
};
}
constexpr int ANDROID_LOG_INFO = 0;
inline void __android_log_print(int, const char *, const char *, ...) {}

namespace audioapi {
struct AudioFileProperties {};
struct AudioFileWriter { int closes = 0; };
struct AudioRecorderCallback { virtual ~AudioRecorderCallback() = default; int cleanups = 0; void setOnErrorCallback(uint64_t) {} };
struct AndroidRecorderCallback : AudioRecorderCallback {
  template <typename... T> explicit AndroidRecorderCallback(T...) {}
  void setOnErrorCallback(uint64_t) {}
  void prepare(float, int, int) {}
};
struct AudioBuffer { AudioBuffer(int, int, float) {} };
struct RecorderAdapterNode { int cleanups = 0; void init(int, int, float) {} };
struct StringPayload { std::string name, reason; };
struct ErrorEvent {
  int count = 0;
  uint64_t getCallbackId() { return 1; }
  void dispatch(StringPayload) { count++; }
};
struct AudioRecorder {
  enum class RecorderState { Idle, Recording, Paused };
  using StopResult = Result<std::tuple<std::vector<std::string>, double, double>, std::string>;
};
struct AndroidAudioRecorder : AudioRecorder, std::enable_shared_from_this<AndroidAudioRecorder> {
  std::mutex callbackMutex_, fileWriterMutex_, adapterNodeMutex_;
  std::atomic<RecorderState> state_{RecorderState::Idle};
  std::atomic<bool> fileOutputConfigured_{false}, callbackOutputConfigured_{false}, connectedConfigured_{false}, isConnected_{false};
  std::atomic<uint64_t> errorCallbackId_{1};
  std::shared_ptr<oboe::AudioStream> mStream_;
  std::shared_ptr<AudioFileWriter> fileWriter_;
  std::shared_ptr<AudioRecorderCallback> dataCallback_;
  std::shared_ptr<RecorderAdapterNode> adapterNode_;
  std::shared_ptr<AudioBuffer> deinterleavingBuffer_;
  std::shared_ptr<AudioFileProperties> fileProperties_ = std::make_shared<AudioFileProperties>();
  int audioEventHandlerRegistry_ = 0;
  struct { float sampleRate = 16000; size_t bufferLength = 1600; int channelCount = 1; uint64_t callbackId = 1; } dataCallbackMetadata_;
  float streamSampleRate_ = 48000;
  int streamChannelCount_ = 1, streamMaxBufferSizeInFrames_ = 128;
  std::vector<std::string> recordingSegmentPaths_;
  std::string filePath_;
  ErrorEvent errors;
  bool failWriter = false, failStreamStart = false;
  int opens = 0, finalized = 0;
  bool isIdle() const { return state_ == RecorderState::Idle; }
  bool isPaused() const { return state_ == RecorderState::Paused; }
  bool wantsFileOutput() const { return true; }
  bool wantsCallback() const { return true; }
  bool wantsConnection() const { return false; }
  bool usesFileOutput() const { return fileOutputConfigured_; }
  bool usesCallback() const { return callbackOutputConfigured_; }
  bool isConnected() const { return isConnected_; }
  ErrorEvent &errorEvent() { return errors; }
  Result<NoneType, std::string> openAudioStream() {
    if (!mStream_) { mStream_ = std::make_shared<oboe::AudioStream>(); opens++; }
    mStream_->callbackOwner = shared_from_this();
    mStream_->failStart = failStreamStart;
    return Result<NoneType, std::string>::Ok(None);
  }
  Result<NoneType, std::string> setupFileWriter(std::shared_ptr<AudioFileProperties>, const std::string &) {
    if (failWriter) return Result<NoneType, std::string>::Err("cache write failed");
    fileWriter_ = std::make_shared<AudioFileWriter>();
    fileOutputConfigured_ = true;
    filePath_ = "fixture.wav";
    recordingSegmentPaths_ = {filePath_};
    return Result<NoneType, std::string>::Ok(None);
  }
  std::vector<std::string> buildOutputPaths(const std::vector<std::string> &paths, const std::string &) { return paths; }
  StopResult finalizeStoppedOutputs(std::shared_ptr<AudioFileWriter> &writer, std::shared_ptr<AudioRecorderCallback> &callback,
      std::shared_ptr<RecorderAdapterNode> &adapter, std::vector<std::string> paths) {
    if (writer) writer->closes++;
    if (callback) callback->cleanups++;
    if (adapter) adapter->cleanups++;
    finalized++;
    return StopResult::Ok(std::make_tuple(paths, 0.0, 0.0));
  }
  void cleanup() { state_ = RecorderState::Idle; if (mStream_) mStream_->close(); mStream_.reset(); }
  Result<NoneType, std::string> start(const std::string &);
  StopResult stop();
  void onErrorAfterClose(oboe::AudioStream *, oboe::Result);
};

/*__RECORDER_START__*/
/*__RECORDER_STOP__*/
/*__RECORDER_ERROR__*/

using ma_uint64 = uint64_t;
using ma_result = int;
constexpr int MA_SUCCESS = 0;
constexpr double MB_IN_BYTES = 1024.0 * 1024;
struct ma_encoder {};
struct ma_data_converter {};
struct ma_decoder { int outputSampleRate = 16000; };
int encoderFrames = 0;
bool encoderTornDown = false;
inline ma_result ma_encoder_write_pcm_frames(ma_encoder *encoder, void *, ma_uint64 frames, ma_uint64 *written) {
  assert(encoder && !encoderTornDown);
  encoderFrames += frames;
  *written = frames;
  return MA_SUCCESS;
}
inline void ma_encoder_uninit(ma_encoder *) { encoderTornDown = true; }
inline void ma_data_converter_uninit(ma_data_converter *, void *) {}
inline void ma_free(void *, void *) {}
inline const char *ma_result_description(ma_result) { return "fixture error"; }
inline int ma_get_bytes_per_sample(int) { return sizeof(float); }
constexpr int ma_format_f32 = 0;
inline int ma_decoder_init_file(const char *, void *, ma_decoder *) { return MA_SUCCESS; }
inline int ma_decoder_get_length_in_pcm_frames(ma_decoder *, ma_uint64 *frames) { *frames = encoderFrames; return MA_SUCCESS; }
inline void ma_decoder_uninit(ma_decoder *) {}
using CloseFileResult = Result<std::pair<double, double>, std::string>;
struct FreeList {
  static constexpr size_t kSentinel = SIZE_MAX;
  size_t next = 0;
  std::optional<size_t> tryAcquire() { return next++; }
  void release(size_t) {}
};
struct WriterData { size_t slot; int numFrames; };
struct Offloader {
  std::vector<WriterData> queue;
  Offloader *getSender() { return this; }
  void send(WriterData value) { queue.push_back(value); }
};
struct AndroidFileWriterBackend {
  std::atomic<bool> isFileOpen_{true};
  std::unique_ptr<Offloader> offloader_ = std::make_unique<Offloader>();
  std::unique_ptr<FreeList> freeSlots_ = std::make_unique<FreeList>();
  std::vector<void *> inputBuffers_;
  float pool[16][16] = {};
  size_t inputBufferBytesPerSlot_ = sizeof(pool[0]);
  int streamChannelCount_ = 1;
  bool isFileOpen() const { return isFileOpen_; }
  virtual void processWriterData(void *, int) = 0;
  virtual ~AndroidFileWriterBackend() = default;
  void writeAudioData(void *, int);
  void runWriterTask(WriterData);
};
struct MiniAudioFileWriter : AndroidFileWriterBackend {
  std::unique_ptr<ma_encoder> encoder_ = std::make_unique<ma_encoder>();
  std::unique_ptr<ma_data_converter> converter_;
  void *processingBuffer_ = nullptr;
  ma_uint64 processingBufferLength_ = 0;
  std::atomic<int> framesWritten_{0};
  std::string filePath_;
  bool convert = false;
  MiniAudioFileWriter() { for (auto &buffer : pool) inputBuffers_.push_back(buffer); }
  bool isConverterRequired() { return convert; }
  ma_uint64 convertBuffer(void *, int frames) { return frames / 3; }
  void invokeOnErrorCallback(std::string) { assert(false); }
  void cleanupPreallocatedInputPool() {
    // Real TaskOffloader::shutdown drains every already accepted item. Test a
    // concurrent new producer against the real backend method during that drain.
    float rejected[2] = {0.5, 0.5};
    const auto before = offloader_->queue.size();
    writeAudioData(rejected, 2);
    assert(offloader_->queue.size() == before);
    for (auto pending : offloader_->queue) runWriterTask(pending);
    offloader_.reset();
    freeSlots_.reset();
    inputBuffers_.clear();
  }
  void processWriterData(void *, int) override;
  CloseFileResult closeFile();
};
/*__WRITER_SUBMIT__*/
/*__WRITER_TASK__*/
/*__WRITER_PROCESS__*/
/*__WRITER_CLOSE__*/
} // namespace audioapi

int main(int argc, char **argv) {
  using namespace audioapi;
  assert(argc == 2);
  const std::string test = argv[1];
  if (test == "partial-start") {
    for (bool writerFailure : {true, false}) {
      auto recorder = std::make_shared<AndroidAudioRecorder>();
      recorder->failWriter = writerFailure;
      recorder->failStreamStart = !writerFailure;
      assert(!recorder->start("").is_ok());
      auto stream = recorder->mStream_;
      std::weak_ptr<AndroidAudioRecorder> lifetime = recorder;
      assert(stream && stream->closes == 0);
      recorder->stop();
      if (recorder->mStream_ || stream->closes != 1 || stream->callbackOwner) {
        std::cerr << "failed start must close the opened stream and break its callback owner cycle\n";
        return 1;
      }
      recorder.reset();
      assert(lifetime.expired());
    }
    auto recorder = std::make_shared<AndroidAudioRecorder>();
    assert(recorder->start("").is_ok());
    auto stream = recorder->mStream_;
    assert(recorder->stop().is_ok());
    assert(!recorder->stop().is_ok());
    assert(stream->closes == 1 && recorder->finalized == 1);
  } else if (test == "tail-flush") {
    for (bool converted : {false, true}) {
      encoderFrames = 0;
      encoderTornDown = false;
      MiniAudioFileWriter writer;
      writer.convert = converted;
      float first[3] = {0.1, 0.2, 0.3}, last[3] = {0.4, 0.5, 0.6};
      writer.writeAudioData(first, 3);
      writer.writeAudioData(last, 3);
      assert(writer.offloader_->queue.size() == 2);
      auto result = writer.closeFile();
      const int expectedFrames = converted ? 2 : 6;
      if (encoderFrames != expectedFrames) {
        std::cerr << "close must drain queued tail frames before encoder teardown\n";
        return 1;
      }
      assert(result.is_ok() && writer.framesWritten_ == 6 && encoderTornDown);
      assert(!writer.isFileOpen());
      assert(!writer.closeFile().is_ok());
    }
  } else if (test == "disconnect") {
    auto recorder = std::make_shared<AndroidAudioRecorder>();
    assert(recorder->start("").is_ok());
    auto stream = recorder->mStream_;
    recorder->onErrorAfterClose(stream.get(), oboe::Result::ErrorDisconnected);
    if (recorder->opens != 1 || recorder->errors.count != 1) {
      std::cerr << "disconnection must report interruption instead of reopening a potentially different source format\n";
      return 1;
    }
    assert(recorder->stop().is_ok());
    assert(!recorder->mStream_ && stream->closes == 1);
    assert(recorder->start("").is_ok());
    auto current = recorder->mStream_;
    recorder->onErrorAfterClose(stream.get(), oboe::Result::ErrorDisconnected);
    assert(recorder->mStream_ == current && recorder->errors.count == 1);
    assert(recorder->stop().is_ok());
    recorder->onErrorAfterClose(current.get(), oboe::Result::ErrorDisconnected);
    assert(recorder->errors.count == 1);
  } else return 2;
  std::cout << test << " passed\n";
}
