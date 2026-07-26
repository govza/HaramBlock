@quick-toggle
Feature: Quick Toggle in a lightbox
  The eye button is attached to the image it belongs to: it sits on the visible
  picture (not the letterbox bars), stays beneath a lightbox backdrop that
  covers its image, and follows the image when the page scrolls.

  Background:
    Given I set the global policy to "process"
    And quick toggle "unsafe" is "enabled"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing

  Scenario: Eye icon lands inside the picture of a letterboxed lightbox image
    When I open a lightbox over the gallery
    And I wait for the lightbox image processing
    And I hover over the lightbox image
    Then I should see the eye toggle icon
    And the eye toggle should be inside the lightbox picture

  Scenario: Eye icon of a covered feed image stays beneath the lightbox backdrop
    When I open a lightbox over the gallery
    And I hover over the first gallery image
    Then the eye toggle should not be on top at its own position

  Scenario: Eye icon stays glued to the image after scrolling
    When I hover over the first gallery image
    Then I should see the eye toggle icon
    When I scroll the page by "120" pixels
    Then the eye toggle should sit at the top-right of the first gallery image
