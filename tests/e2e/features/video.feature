@video
Feature: Video Masking
  Videos are adopted into VideoSessions, verdicted via Thumbnail and playback
  Frame Samples, and masked protection-first (see docs/VIDEO_PROCESSING.md).

  Background:
    Given I set the global policy to "process"
    And video processing is enabled

  Scenario: Unsafe poster is masked before any playback
    Given I open the video test page with "nsf-female" images
    When I inject a video using the first gallery image as poster
    Then the video is verdicted "unsafe" within the inference timeout
    And I should see at least "1" video mask overlays

  Scenario: A playing safe video is verdicted clean without masking
    Given I open the video test page with "sf-neutral" images
    When I inject and play a generated safe video using "src"
    Then the video is verdicted "safe" within the inference timeout
    And I should see exactly "0" video mask overlays

  Scenario: A source-child video is adopted via loadstart and verdicted
    Given I open the video test page with "sf-neutral" images
    When I inject and play a generated safe video using "source-child"
    Then the video is verdicted "safe" within the inference timeout
