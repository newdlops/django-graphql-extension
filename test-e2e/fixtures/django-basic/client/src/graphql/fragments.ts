import gql from "graphql-tag";

export const OPTION_QUANTITY_FRAGMENT = gql`
  fragment OptionQuantityFragment on OptionStatsType {
    softLimitAuthorizedOptionQuantity
    grantedOptionsQuantity
    exercisedOptionsQuantity
    isRecoverGrantableOptionsAfterExercise
  }
`;

export const OPTION_GROUP_SUMMARIES_FRAGMENT = gql`
  fragment OptionGroupSummariesFragment on Query {
    optionGroupSummaries(baseDate: $baseDate) {
      label
      grantQuantity
      currentQuantity
      exercisedQuantity
      exerciseHistories {
        date
        quantity
      }
    }
  }
`;
