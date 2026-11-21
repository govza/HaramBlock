@cloud @desktop-only
Feature: Cloud Predictions consent
  One consent state decides whether this install shares its predictions. The consent tab answers
  it once; the switch in Options is the same agree click and keeps the Install ID when off.

  Scenario: "Not now" leaves Cloud Predictions off and reports nothing
    Given I set the global policy to "process"
    When I open the Cloud Predictions consent tab
    And I answer "Not now" on the consent tab
    Then the consent tab closes
    And the Cloud Predictions consent is "declined"
    When I go to the "not-safe" basic gallery with "1" "medium" images
    And I wait for image processing
    Then no cached image prediction is reported

  @chrome-only
  Scenario: The options switch acts as the agree click and keeps the Install ID when off
    When I open the Cloud Predictions options section
    Then the Cloud Predictions section shows "neverAgreed"
    And no Install ID is shown
    When I switch Cloud Predictions "on"
    Then the Cloud Predictions consent is "agreed"
    And the Cloud Predictions section shows "on"
    And the Install ID is shown
    And the deletion email carries the Install ID
    When I switch Cloud Predictions "off"
    Then the Cloud Predictions consent is "declined"
    And the Cloud Predictions section shows "off"
    And the Install ID is still the same
    And the deletion email carries the Install ID
