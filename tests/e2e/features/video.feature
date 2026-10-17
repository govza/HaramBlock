# Desktop-only: these scenarios rely on Live Masking and attachment blur, which Firefox for Android
# does not have (lookahead-only, ADR 0005).
@video @desktop-only
Feature: Video Masking
  Videos play natively. Lookahead Analysis reads the bitstream through a
  Bitstream Tap and masks unsafe spans before they are shown; Live Masking
  covers videos whose bitstream is unreachable (see docs/VIDEO_PROCESSING.md).

  Background:
    Given I set the global policy to "process"
    And video processing is enabled

  Scenario: Unsafe poster is masked before any playback
    Given I open the video test page with "nsf-female" images
    When I inject a video using the first gallery image as poster
    Then the video is verdicted "unsafe" within the inference timeout
    And I should see at least "1" video mask overlays

  Scenario: A progressive video is analysed through a range fetch and stays unmasked when clean
    Given I open the video test page with "sf-neutral" images
    When I inject and play a safe video using "src"
    Then the video tap is "progressive"
    And the video is verdicted "safe" within the inference timeout
    And I should see exactly "0" video mask overlays

  Scenario: A source-child video is adopted via loadstart and verdicted
    Given I open the video test page with "sf-neutral" images
    When I inject and play a safe video using "source-child"
    Then the video is verdicted "safe" within the inference timeout

  Scenario: An MSE video is analysed through the append hook
    Given I open the video test page with "sf-neutral" images
    When I inject and play a "safe" video through a minimal MSE appender
    Then the video tap is "mse"
    And the video is verdicted "safe" within the inference timeout

  Scenario: Lookahead masks an unsafe span before its first sampled frame is shown
    Given I open the video test page with "nsf-female" images
    When I inject a paused "turns-unsafe" video using "src"
    And lookahead analysis has published an unsafe sample for the video
    And I play the test video while recording mask visibility
    Then the mask was visible when playback reached the first unsafe sample
    And no mask was visible over the clean span before it
    And the video is verdicted "unsafe" within the inference timeout

  Scenario: A video with an unreachable bitstream falls back to Live Masking
    Given I open the video test page with "nsf-female" images
    When I inject and play an "unsafe" video from a plain blob URL
    Then the video tap is "none"
    And the video is verdicted "unsafe" within the inference timeout
    And I should see at least "1" video mask overlays
