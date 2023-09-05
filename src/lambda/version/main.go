package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/ssm"
)

func main() {
	lambda.Start(handler)
}

func handler(request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	sess := session.Must(session.NewSession(&aws.Config{
		Region: aws.String(os.Getenv("REGION")),
	}))

	ssmClient := ssm.New(sess)

	imageTagParamName := os.Getenv("IMAGE_TAG_PARAMETER_NAME")
	versionParamName := os.Getenv("VERSION_PARAMETER_NAME")

	imageTagParam, err := ssmClient.GetParameter(&ssm.GetParameterInput{
		Name: aws.String(imageTagParamName),
	})

	if err != nil {
		return events.APIGatewayProxyResponse{
			Body:       fmt.Sprintf("error in retrieving git hash: %v", err),
			StatusCode: http.StatusInternalServerError,
		}, nil
	}

	versionParam, err := ssmClient.GetParameter(&ssm.GetParameterInput{
		Name: aws.String(versionParamName),
	})

	if err != nil {
		return events.APIGatewayProxyResponse{
			Body:       fmt.Sprintf("error in retrieving version: %v", err),
			StatusCode: http.StatusInternalServerError,
		}, nil
	}

	gitHash := *imageTagParam.Parameter.Value
	version := *versionParam.Parameter.Value

	responseBody, err := json.Marshal(map[string]string{
		"commit":  gitHash,
		"version": version,
	})

	if err != nil {
		return events.APIGatewayProxyResponse{
			Body:       fmt.Sprintf("error in creating response body: %v", err),
			StatusCode: http.StatusInternalServerError,
		}, nil
	}

	return events.APIGatewayProxyResponse{
		Body:       string(responseBody),
		StatusCode: http.StatusOK,
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
	}, nil
}
