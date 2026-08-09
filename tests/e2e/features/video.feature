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

  # Continuous DVR: every playing processed video presents through the delayed
  # canvas from play onward, clean ones included (ADR 0001).
  @desktop-only
  Scenario: A clean playing video is presented through the delayed DVR canvas
    Given I open the video test page with "sf-neutral" images
    When I inject and play a generated safe video using "src"
    Then the video is verdicted "safe" within the inference timeout
    And the DVR canvas player replaces the native video

  Scenario: A source-child video is adopted via loadstart and verdicted
    Given I open the video test page with "sf-neutral" images
    When I inject and play a generated safe video using "source-child"
    Then the video is verdicted "safe" within the inference timeout

  # Fenix records a detached canvas's captureStream without the drawn content, so an
  # unsafe recording cannot be generated there; the DVR path is engine-agnostic and
  # covered on desktop Chrome and Firefox.
  @desktop-only
  Scenario: An unsafe playing video is presented through the delayed DVR canvas
    Given I open the video test page with "nsf-female" images
    When I inject and play a generated unsafe video
    Then the video is verdicted "unsafe" within the inference timeout
    And the DVR canvas player replaces the native video

  # The continuous DVR is already presenting when the unsafe verdict lands, so
  # it composites into the running canvas with no whole-blur mode switch.
  @desktop-only
  Scenario: An unsafe verdict mid-playback composites without a whole-blur flash
    Given I open the video test page with "nsf-female" images
    When I inject and play a generated video that turns unsafe mid-playback
    And I watch the native video for whole-blur changes
    Then the DVR canvas player replaces the native video
    And the video is verdicted "unsafe" within the inference timeout
    And no whole-blur was applied after the DVR canvas took over
