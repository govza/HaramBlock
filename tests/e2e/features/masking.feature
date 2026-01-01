@masking
Feature: Image Masking
  Test segment and bounding box overlay types
  # Segment outline (canvas mask)

  Scenario: Segment outline masks unsafe images
    Given I set the global policy to "process"
    Given the outline type is set to "segment"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    Then I should see at least "1" segment mask overlays with canvas

  Scenario: Segment outline on large images
    Given I set the global policy to "process"
    Given the outline type is set to "segment"
    When I go to the "not-safe" basic gallery with "1" "large" images
    Then I should see at least "1" segment mask overlays with canvas
  # Bounding box outline

  Scenario: Bounding box outline masks unsafe images
    Given I set the global policy to "process"
    Given the outline type is set to "bbox"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    Then I should see at least "1" bounding box overlays
  # Safe images

  Scenario: Safe images are not masked
    Given I set the global policy to "process"
    Given the outline type is set to "segment"
    When I go to the "safe" basic gallery with "5" "medium" images
    Then I should see "0" mask overlays
  # Extended tests with more images
